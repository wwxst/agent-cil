import React, { createContext, useCallback, useContext } from 'react';

const noop = () => {};
const NotificationContext = createContext({
  addNotification: noop,
  removeNotification: noop,
});

export function NotificationsProvider({ children, onNotification }) {
  const addNotification = useCallback(notification => {
    onNotification?.(notification);
  }, [onNotification]);
  const removeNotification = useCallback(key => {
    onNotification?.({ key, remove: true });
  }, [onNotification]);
  return React.createElement(NotificationContext.Provider, {
    value: { addNotification, removeNotification },
  }, children);
}

export function useNotifications() {
  return useContext(NotificationContext);
}
