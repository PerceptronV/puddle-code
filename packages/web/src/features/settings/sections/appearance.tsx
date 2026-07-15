import { useState } from 'react';
import { Input } from '../../../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import { Switch } from '../../../components/ui/switch';
import {
  DEFAULT_CLIENT_SETTINGS,
  updateClientSettings,
  useClientSettings,
} from '../../../lib/client-settings';
import { applyTheme, storedPreference, type ThemePreference } from '../../../lib/theme';
import { SectionTitle, SettingRow } from '../parts';

export function AppearanceSection() {
  const settings = useClientSettings();
  const [themePref, setThemePref] = useState<ThemePreference>(storedPreference());

  return (
    <div>
      <SectionTitle note="This browser only">Appearance</SectionTitle>
      <SettingRow label="Theme" description="Chrome, terminal, and editor restyle together.">
        <Select
          value={themePref}
          onValueChange={(value) => {
            setThemePref(value as ThemePreference);
            applyTheme(value as ThemePreference);
          }}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dark">Dark</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label="UI font size" htmlFor="ui-font-size">
        <Input
          id="ui-font-size"
          type="number"
          min={12}
          max={24}
          step={0.5}
          className="w-20 tabular-nums"
          value={settings.uiFontSize}
          onChange={(e) =>
            updateClientSettings({
              uiFontSize: Number(e.target.value) || DEFAULT_CLIENT_SETTINGS.uiFontSize,
            })
          }
        />
      </SettingRow>
      <SettingRow label="Terminal font size" htmlFor="terminal-font-size">
        <Input
          id="terminal-font-size"
          type="number"
          min={9}
          max={24}
          className="w-20 tabular-nums"
          value={settings.terminalFontSize}
          onChange={(e) => updateClientSettings({ terminalFontSize: Number(e.target.value) || 13 })}
        />
      </SettingRow>
      <SettingRow label="Density">
        <Select
          value={settings.density}
          onValueChange={(value) =>
            updateClientSettings({ density: value as 'compact' | 'comfortable' })
          }
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="compact">Compact</SelectItem>
            <SelectItem value="comfortable">Comfortable</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        label="Reduced motion"
        description="Status ripples become static dots."
        htmlFor="reduced-motion"
      >
        <Switch
          id="reduced-motion"
          checked={settings.reducedMotion}
          onCheckedChange={(checked) => updateClientSettings({ reducedMotion: checked })}
        />
      </SettingRow>
      <SettingRow
        label="All projects in the sidebar"
        description="Show every project's sessions in the right sidebar, grouped by project."
        htmlFor="all-project-sessions"
      >
        <Switch
          id="all-project-sessions"
          checked={settings.showAllProjectSessions}
          onCheckedChange={(checked) => updateClientSettings({ showAllProjectSessions: checked })}
        />
      </SettingRow>
    </div>
  );
}
