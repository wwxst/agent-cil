import { fileURLToPath } from 'node:url';
import { createTuiController } from './controller.js';
import { translate } from '../i18n.js';

let tsxRegistered = false;

export async function startAgentTui({ locale, model, permissionMode, onSubmit, onInterrupt }) {
  if (!tsxRegistered) {
    process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url));
    const { register } = await import('tsx/esm/api');
    register();
    tsxRegistered = true;
  }
  const ReactModule = await import('react');
  const React = ReactModule.default ?? ReactModule;
  const [
    { default: render },
    { default: AgentTui },
    { NotificationsProvider },
    { loadPromptHistory, flushPromptHistory },
  ] = await Promise.all([
    import('../../../../legacy/2.1.88/restored-src/src/ink/root.ts'),
    import('./AgentTui.tsx'),
    import('../../../../legacy/2.1.88/restored-src/src/context/notifications.js'),
    import('../../../../legacy/2.1.88/restored-src/src/history.js'),
  ]);
  const controller = createTuiController({ locale, model, permissionMode });
  const initialHistory = await loadPromptHistory({ limit: 100 }).catch(() => []);
  const onNotification = notification => {
    const localized = notification?.text === 'Esc again to clear'
      ? { ...notification, text: translate(locale, 'pressEscAgainToClear') }
      : notification;
    controller.setNotification(localized);
  };
  try {
    const app = React.createElement(NotificationsProvider, { onNotification },
      React.createElement(AgentTui, {
        controller,
        initialHistory,
        onSubmit,
        onInterrupt,
        onExit: () => controller.close(0),
      }),
    );
    const instance = await render(app, { exitOnCtrlC: false, patchConsole: true });
    controller.attachInstance(instance);
    void controller.waitUntilExit().then(() => flushPromptHistory()).catch(() => {});
    return controller;
  } catch (error) {
    controller.close(1);
    await controller.waitUntilExit();
    throw error;
  }
}
