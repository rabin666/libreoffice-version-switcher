// Editable list of folder paths (e.g. scan folders): remove existing ones, add new ones with Enter or "Add".
import { useState } from 'react';
import { Button, CloseButton } from '../ui/index.js';

export default function PathListInput({ id, paths, onChange }) {
  const [newPath, setNewPath] = useState('');

  const addPath = () => {
    const trimmed = newPath.trim();
    if (trimmed && !paths.includes(trimmed)) onChange([...paths, trimmed]);
    setNewPath('');
  };

  const removePath = (path) => onChange(paths.filter((existing) => existing !== path));

  return (
    <div className="path-list">
      {paths.map((path) => (
        <div key={path} className="path-list-item">
          <span className="mono break">{path}</span>
          <CloseButton label={`Remove ${path}`} onClick={() => removePath(path)} />
        </div>
      ))}
      <div className="path-list-add">
        <input
          id={id}
          className="input mono"
          type="text"
          placeholder="D:\LibreOfficePortable"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addPath()}
          spellCheck={false}
        />
        <Button size="sm" onClick={addPath} disabled={!newPath.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}
