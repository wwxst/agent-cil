// Headless dependency closure of pinned 2.1.88
// tasks/LocalShellTask/{LocalShellTask,killShellTasks}.ts and
// tools/{TaskOutputTool,TaskStopTool}. Keep task ownership scoped to
// a running agent CLI session; no implicit OS-detached daemon or replay.
const TERMINAL = new Set(['completed','failed','killed']);
const MAX_TASKS=128;
const WAIT_STEP_MS=100;
const MAX_OUTPUT_CHARS=30000;
// 2.1.88 LocalShellTask.enqueueShellNotification serializes task state into
// a tagged, provider-visible notification. Never embed unescaped commands.
const escapeXml=value=>String(value).replace(/[&<>"']/g, c=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function createShellNotification(task) {
  const summary='Background command "'+task.description+'" '+
    (task.status==='completed'?'completed (exit code '+task.exitCode+')':
      'failed'+(task.exitCode!==null?' with exit code '+task.exitCode:''));
  return '<task_notification>\n'+
    '<task_id>'+task.id+'</task_id>\n'+
    '<output_file>'+escapeXml(task.taskOutput.path)+'</output_file>\n'+
    '<status>'+task.status+'</status>\n'+
    '<summary>'+escapeXml(summary)+'</summary>\n'+
    '</task_notification>';
}

export class LocalShellTaskManager {
  #tasks = new Map();
  #notifications = new Map();
  #closed = false;
  constructor({sessionId=null}={}) {this.sessionId=sessionId;}

  spawnShellTask({taskOutput,command,kill,completion}) {
    if(this.#closed) throw new Error('Cannot register Bash task after agent cleanup.');
    if(this.#tasks.size>=MAX_TASKS)
      throw new RangeError('Background Bash task limit (128) reached.');
    const taskId=taskOutput?.taskId;
    if(!taskId || typeof kill!=='function' ||
       typeof completion?.then!=='function' || this.#tasks.has(taskId))
      throw new TypeError('LocalShellTask requires a unique live ShellCommand.');
    const state={
      id:taskId,type:'local_bash',status:'running',command,
      description:command,notified:false,isBackgrounded:true,
      taskOutput,kill,completion,exitCode:null,error:null,
      startTime:Date.now(),endTime:null,
    };
    this.#tasks.set(taskId,state);
    // A background task can complete before its initial tool_result is
    // committed. Maintain state independently, but NEVER inject an
    // unsolicited provider message or replay a command.
    void completion.then(
      result=>{
        if(state.status==='killed')return;
        state.status=result.exit_code===0?'completed':'failed';
        state.exitCode=result.exit_code;
        state.error=result.error??null;
        state.endTime=Date.now();
        this.#enqueueShellNotification(state);
      },
      error=>{
        if(state.status==='killed')return;
        state.status='failed';
        state.error=error instanceof Error?error.message:String(error);
        state.endTime=Date.now();
        this.#enqueueShellNotification(state);
      },
    );
    return taskId;
  }

  // Ported LocalShellTask.enqueueShellNotification/markTaskNotified:
  // enqueue once on natural terminal transition, atomically suppress a
  // redundant message if TaskOutput/TaskStop already acknowledged the task.
  #enqueueShellNotification(task) {
    if(task.notified || this.#closed || this.#notifications.has(task.id) ||
       !TERMINAL.has(task.status) || task.status==='killed')return;
    this.#notifications.set(task.id,createShellNotification(task));
  }
  pendingNotifications() {
    return [...this.#notifications].map(([taskId,text])=>({taskId,text}));
  }
  acknowledgeNotifications(taskIds) {
    if(!Array.isArray(taskIds))throw new TypeError('Task notification IDs must be an array.');
    for(const taskId of taskIds) {
      if(!this.#notifications.has(taskId))continue;
      this.#notifications.delete(taskId);
      const task=this.#tasks.get(taskId);
      if(task)task.notified=true;
    }
  }
  markTaskNotified(taskId) {
    const task=this.#tasks.get(taskId);
    if(!task)return false;
    task.notified=true;
    this.#notifications.delete(taskId);
    return true;
  }

  has(taskId) {return this.#tasks.has(taskId);}
  status(taskId) {
    const task=this.#tasks.get(taskId);
    if(!task)return null;
    return {
      id:task.id,type:task.type,status:task.status,
      description:task.description,exitCode:task.exitCode,
      outputFilePath:task.taskOutput.path,
      startTime:task.startTime,endTime:task.endTime,
      notified:task.notified,
    };
  }

  async getTaskOutput({task_id,block=true,timeout=30000}={},signal) {
    if(!Number.isSafeInteger(timeout)||timeout<0||timeout>600000)
      throw new RangeError('TaskOutput timeout must be 0..600000 ms.');
    if(typeof task_id!=='string')
      throw new TypeError('TaskOutput requires task_id.');
    const task=this.#tasks.get(task_id);
    if(!task)throw new Error('No task found with ID: '+task_id);
    const start=Date.now();
    if(block && task.status==='running') {
      while(task.status==='running' && Date.now()-start<timeout){
        if(signal?.aborted)throw signal.reason instanceof Error?
          signal.reason:new Error('TaskOutput interrupted.');
        await new Promise(resolve=>{
          const delay=Math.min(WAIT_STEP_MS,Math.max(1,timeout-(Date.now()-start)));
          const timer=setTimeout(resolve,delay);
          // The caller (AgentLoop) owns this wait; no unref, so an
          // explicitly blocking TaskOutput cannot silently drop the CLI.
          void timer;
        });
      }
    }
    if(signal?.aborted)throw signal.reason instanceof Error?
      signal.reason:new Error('TaskOutput interrupted.');
    let output;
    try {
      // Native 2.1.88 file mode: bounded 30k getStdout() and original path.
      output=await task.taskOutput.getStdout();
    }catch(error){
      // A still-running background shell can be growing the file.
      // A disappeared or replaced output is never silently treated as empty.
      throw new Error('Background task output unavailable: '+
        (error instanceof Error?error.message:String(error)),{cause:error});
    }
    const status=task.status;
    const retrieval_status=status==='running'?
      (block?'timeout':'not_ready'):'success';
    if(TERMINAL.has(status))this.markTaskNotified(task.id);
    return {
      retrieval_status,
      task:{
        task_id:task.id,task_type:task.type,status,
        description:task.description,
        output:output.slice(0,MAX_OUTPUT_CHARS+500),
        exitCode:task.exitCode,
        ...(task.error?{error:task.error}:{}),
      },
    };
  }

  async stopTask(taskId, {markSideEffectsStarted}={}) {
    const task=this.#tasks.get(taskId);
    if(!task)throw new Error('No task found with ID: '+taskId);
    if(task.status!=='running')
      throw new Error('Task '+taskId+' is not running (status: '+task.status+').');
    // Preserve the original killTask state transition while awaiting the
    // existing ShellCommand process-tree cleanup (important on Windows).
    // An unknown/already-stopped ID is a recoverable tool error; only an
    // actual request to kill a live process crosses the mutation boundary.
    markSideEffectsStarted?.();
    await task.kill();
    try{await task.completion;}catch{}
    task.status='killed';
    task.exitCode??=1;
    this.markTaskNotified(taskId);
    task.endTime=Date.now();
    return {
      message:'Successfully stopped task: '+taskId+' ('+task.command+')',
      task_id:taskId,task_type:task.type,command:task.command,
    };
  }

  async killShellTasksForAgent() {
    this.#closed=true;
    this.#notifications.clear();
    const active=[...this.#tasks.values()].filter(task=>task.status==='running');
    const results=await Promise.allSettled(active.map(task=>this.stopTask(task.id)));
    const failures=results.filter(r=>r.status==='rejected').map(r=>r.reason);
    if(failures.length)
      throw new AggregateError(failures,
        'Failed to stop all background Bash tasks while exiting agent.');
  }
}

export function createLocalShellTaskManager(options) {
  return new LocalShellTaskManager(options);
}
