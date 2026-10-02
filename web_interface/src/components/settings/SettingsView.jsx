// "Settings" tab: edit the lovs config and save only the changed keys (PUT /api/config).
import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useConfigDraft } from '../../hooks/useConfigDraft.js';
import { classNames } from '../../lib/classNames.js';
import { Button, LoadingPanel, useToast, ViewHeader } from '../ui/index.js';
import SettingField from './SettingField.jsx';
import { SETTING_GROUPS, settingLabel, visibleSettingKeys } from './settingsLayout.js';
import ToolsCard from './ToolsCard.jsx';

export default function SettingsView({ info, onSaved }) {
  const showToast = useToast();
  const { draft, changedKeys, setValue, discard } = useConfigDraft(info?.config);
  const [saving, setSaving] = useState(false);
  const schemaByKey = useMemo(() => Object.fromEntries((info?.schema ?? []).map((setting) => [setting.key, setting])), [info]);

  if (!info || !draft) return <LoadingPanel label="Loading settings…" />;

  const save = async () => {
    setSaving(true);
    try {
      const changes = Object.fromEntries(changedKeys.map((key) => [key, draft[key]]));
      await api('/api/config', { method: 'PUT', body: changes });
      showToast('success', 'Settings saved');
      onSaved();
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="view">
      <ViewHeader
        title="Settings"
        description={
          <>
            Stored in <span className="mono">{info.home}</span>. The CLI (<span className="mono">lovs config</span>) uses the same file.
          </>
        }
        actions={
          <>
            <Button variant="ghost" disabled={!changedKeys.length || saving} onClick={discard}>
              Discard
            </Button>
            <Button variant="primary" disabled={!changedKeys.length} busy={saving} onClick={save}>
              Save{changedKeys.length ? ` (${changedKeys.length})` : ''}
            </Button>
          </>
        }
      />

      <ToolsCard info={info} />

      {SETTING_GROUPS.map((group) => {
        const keys = visibleSettingKeys(group, schemaByKey, info.platform.os);
        if (!keys.length) return null;
        return (
          <fieldset key={group.title} className="settings-group">
            <legend>{group.title}</legend>
            {keys.map((key) => (
              <SettingRow
                key={key}
                settingKey={key}
                setting={schemaByKey[key]}
                value={draft[key]}
                isChanged={changedKeys.includes(key)}
                onChange={(value) => setValue(key, value)}
              />
            ))}
          </fieldset>
        );
      })}
    </section>
  );
}

function SettingRow({ settingKey, setting, value, isChanged, onChange }) {
  const inputId = `cfg-${settingKey}`;
  return (
    <div className={classNames('setting', isChanged && 'is-changed')}>
      <div className="setting-label">
        <label htmlFor={inputId}>{settingLabel(settingKey)}</label>
        <div className="muted small">{setting.description}</div>
      </div>
      <div className="setting-control">
        <SettingField id={inputId} setting={setting} value={value} onChange={onChange} />
      </div>
    </div>
  );
}
