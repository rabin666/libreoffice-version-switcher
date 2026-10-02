// Top-level tab navigation with optional count badges.
import { classNames } from '../../lib/classNames.js';

/** `counts` maps a tab id to the number shown next to its label; falsy counts are hidden. */
export function TabBar({ tabs, activeTab, counts, onSelect }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const count = counts[tab.id];
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={classNames('tab', isActive && 'is-active')}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {count ? <span className={classNames('tab-count', tab.live && 'is-live')}>{count}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
