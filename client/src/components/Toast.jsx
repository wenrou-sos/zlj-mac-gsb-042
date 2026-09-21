import { createContext, useContext, useState, useCallback } from 'react';

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, type = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems(xs => [...xs, { id, msg, type }]);
    setTimeout(() => setItems(xs => xs.filter(x => x.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {items.map(t => <div key={t.id} className={`toast toast-${t.type}`}>
          {t.type === 'error' ? '⚠️ ' : t.type === 'success' ? '✅ ' : ''}{t.msg}
        </div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
