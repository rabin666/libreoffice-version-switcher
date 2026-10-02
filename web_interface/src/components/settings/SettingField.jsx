// Picks the input control for a config setting based on its schema type.
import { SegmentedControl, Toggle } from '../ui/index.js';
import PathListInput from './PathListInput.jsx';

export default function SettingField({ id, setting, value, onChange }) {
  switch (setting.type) {
    case 'boolean':
      return <Toggle id={id} checked={Boolean(value)} onChange={onChange} />;
    case 'enum':
      return <SegmentedControl options={setting.values.map((option) => ({ value: option, label: option }))} value={value} onChange={onChange} />;
    case 'number':
      return (
        <input
          id={id}
          className="input input-num"
          type="number"
          min={setting.min}
          max={setting.max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      );
    case 'paths':
      return <PathListInput id={id} paths={value} onChange={onChange} />;
    default:
      return <input id={id} className="input mono" type="text" value={value} placeholder="(auto)" onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  }
}
