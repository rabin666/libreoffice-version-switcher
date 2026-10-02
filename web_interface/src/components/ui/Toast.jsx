// Toast notifications: <ToastProvider> renders the stack, useToast() returns showToast(tone, message, timeoutMs?).
import { createContext, useCallback, useContext, useState } from 'react';
import { CloseButton } from './controls.jsx';

const ERROR_TIMEOUT_MS = 9000;
const DEFAULT_TIMEOUT_MS = 5000;

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismissToast = useCallback((id) => setToasts((all) => all.filter((toast) => toast.id !== id)), []);

  // Errors stay up longer because they usually need to be read in full.
  const showToast = useCallback(
    (tone, message, timeoutMs = tone === 'error' ? ERROR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((all) => [...all, { id, tone, message }]);
      setTimeout(() => dismissToast(id), timeoutMs);
    },
    [dismissToast],
  );

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
            <CloseButton label="Dismiss" onClick={() => dismissToast(toast.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
