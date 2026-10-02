// Dropdown menu anchored to a button; closes on an outside click, on Escape or after a choice.
import { useEffect, useRef, useState } from 'react';
import { classNames } from '../../lib/classNames.js';
import { Button } from './controls.jsx';

/**
 * `items` is a list of { label, onClick, danger, disabled, hint }.
 * Falsy entries are skipped, so callers can write `condition && { ... }`.
 */
export function Menu({ label, items, variant = 'ghost', size = 'sm', align = 'right' }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnOutsideClick = (e) => !menuRef.current?.contains(e.target) && setIsOpen(false);
    const closeOnEscape = (e) => e.key === 'Escape' && setIsOpen(false);
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const choose = (item) => {
    setIsOpen(false);
    item.onClick();
  };

  return (
    <div className="menu" ref={menuRef}>
      <Button variant={variant} size={size} onClick={() => setIsOpen((open) => !open)} aria-haspopup="menu" aria-expanded={isOpen}>
        {label}
      </Button>
      {isOpen && (
        <div className={`menu-list menu-${align}`} role="menu">
          {items.filter(Boolean).map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={classNames('menu-item', item.danger && 'is-danger')}
              disabled={item.disabled}
              onClick={() => choose(item)}
            >
              <span>{item.label}</span>
              {item.hint && <span className="menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
