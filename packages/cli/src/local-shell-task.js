// Headless dependency closure of pinned 2.1.88
// tasks/LocalShellTask/{LocalShellTask,killShellTasks}.ts and
// tools/{TaskOutputTool,TaskStopTool}. Keep task ownership scoped to
// a running agent CLI session; no implicit OS-detached daemon or replay.
const TERMINAL = new Set(['completed','failed','killed']);
const MAX_TASKS=128;
const WAIT_STEP_MS=100;
const MAX_OUTPUT_CHARS=30000;

export class LocalShellTaskManager {
  #tasks = new Map();
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
      },
      error=>{
        if(state.status==='killed')return;
        state.status='failed';
        state.error=error instanceof Error?error.message:String(error);
        state.endTime=Date.now();
      },
    );
    return taskId;
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
    if(TERMINAL.has(status))task.notified=true;
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

  async stopTask(taskId) {
    const task=this.#tasks.get(taskId);
    if(!task)throw new Error('No task found with ID: '+taskId);
    if(task.status!=='running')
      throw new Error('Task '+taskId+' is not running (status: '+task.status+').');
    // Preserve the original killTask state transition while awaiting the
    // existing ShellCommand process-tree cleanup (important on Windows).
    await task.kill();
    try{await task.completion;}catch{}
    task.status='killed';
    task.exitCode??=1;
    task.notified=true;
    task.endTime=Date.now();
    return {
      message:'Successfully stopped task: '+taskId+' ('+task.command+')',
      task_id:taskId,task_type:task.type,command:task.command,
    };
  }

  async killShellTasksForAgent() {
    this.#closed=true;
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
