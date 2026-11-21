import type { ReactElement } from 'react'
import type { ThemePreference } from '@reflect/core'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import {
  useSettingsService,
  useSettingsStore,
  useThemeSetting,
} from '@/providers/settings-provider.tsx'
import { useAppServices } from '@/services/services-provider.tsx'
import { SettingsField } from './field.tsx'
import { SettingsOptionCard } from './option-card.tsx'
import { SettingsSection } from './section.tsx'
import { SettingsSwitchField } from './switch-field.tsx'

interface ThemeOption {
  value: ThemePreference
  label: string
  icon: LucideIcon
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

/**
 * Theme picker as radio cards, with activity heatmap and status bar toggles.
 */
export function AppearanceSection(): ReactElement {
  const settings = useSettingsStore()
  const settingsService = useSettingsService()
  const theme = useThemeSetting()
  const { theme: themeService } = useAppServices()

  return (
    <SettingsSection id="appearance">
      <SettingsField legend="Theme" description="System follows your OS appearance.">
        <div className="mt-3 grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const selected = theme === value
            return (
              <SettingsOptionCard
                key={value}
                selected={selected}
                className={cn(
                  'flex-col items-center gap-1.5 px-3 py-3',
                  selected ? 'text-accent-soft-text' : 'text-text-secondary',
                )}
              >
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={selected}
                  onChange={() => themeService.setPreference(value)}
                  className="sr-only"
                />
                <Icon aria-hidden strokeWidth={1.75} className="size-4" />
                <span className="text-xs font-medium">{label}</span>
              </SettingsOptionCard>
            )
          })}
        </div>
      </SettingsField>
      <SettingsSwitchField
        legend="Activity heatmap"
        description="Show how much you wrote each day in the daily sidebar."
        checked={settings.activityHeatmapEnabled}
        onCheckedChange={(checked) => settingsService.update({ activityHeatmapEnabled: checked })}
      />
      <SettingsSwitchField
        legend="Status bar"
        description="Show the note's character count along the bottom of the editor."
        checked={settings.statusBarEnabled}
        onCheckedChange={(checked) => settingsService.update({ statusBarEnabled: checked })}
      />
    </SettingsSection>
  )
}
