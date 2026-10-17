import fs from 'node:fs';
import path from 'node:path';

export interface AppearanceSettings {
  brightness: number;
  primaryHue: number;
  secondaryHue: number;
}

const DEFAULT_APPEARANCE: AppearanceSettings = {
  brightness: 100,
  primaryHue: 145,
  secondaryHue: 13,
};

export class AppearanceSettingsStore {
  private readonly filePath: string;

  constructor(workspace: string) {
    this.filePath = path.join(workspace, '.agents', 'appearance.json');
  }

  isInitialized(): boolean {
    return fs.existsSync(this.filePath);
  }

  read(): AppearanceSettings {
    if (!fs.existsSync(this.filePath)) return { ...DEFAULT_APPEARANCE };
    const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    return validateAppearanceSettings(parsed);
  }

  write(value: unknown): AppearanceSettings {
    const settings = validateAppearanceSettings(value);
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
    return settings;
  }
}

export function validateAppearanceSettings(value: unknown): AppearanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Appearance settings must be an object.');
  }
  const settings = value as Record<string, unknown>;
  const { brightness, primaryHue, secondaryHue } = settings;
  if (typeof brightness !== 'number' || !Number.isFinite(brightness) || brightness < 0 || brightness > 100
    || typeof primaryHue !== 'number' || !Number.isFinite(primaryHue) || primaryHue < 0 || primaryHue > 360
    || typeof secondaryHue !== 'number' || !Number.isFinite(secondaryHue) || secondaryHue < 0 || secondaryHue > 360) {
    throw new RangeError('Appearance brightness must be from 0 to 100 and color hues must be from 0 to 360.');
  }
  return { brightness, primaryHue, secondaryHue };
}
