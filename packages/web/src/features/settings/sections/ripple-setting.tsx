import { Switch } from '../../../components/ui/switch';
import { updateClientSettings, useClientSettings } from '../../../lib/settings/client-settings';
import { resetRippleBoundaries } from '../../terminal/ripple/preferences';
import { SettingRow } from '../parts';

/** One appearance preference and reset policy for desktop and phone settings. */
export function RippleSetting() {
  const settings = useClientSettings();
  return (
    <SettingRow
      label="Ripple (experimental)"
      description="Start with Ripple covering output and input. When off, start with the full CLI. Drag the handle to adjust either view."
      htmlFor="ripple-enabled"
    >
      <Switch
        id="ripple-enabled"
        checked={settings.rippleEnabled === true}
        onCheckedChange={(rippleEnabled) => {
          updateClientSettings({ rippleEnabled });
          resetRippleBoundaries();
        }}
      />
    </SettingRow>
  );
}
