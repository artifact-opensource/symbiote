// Symbiote — Config Validation (fixes Pain #1, #9)
// Validates config BEFORE anything starts. Never crash-loop.

import type { SymbioteConfig } from './config.js';

export interface ValidationError {
  field: string;
  message: string;
  suggestion?: string;
  severity: 'error' | 'warning';
}

/**
 * Validate config and return all issues found.
 * Errors = fatal (must fix). Warnings = suspicious but allowed.
 */
export function validateConfig(config: SymbioteConfig): ValidationError[] {
  const issues: ValidationError[] = [];

  // Check provider config
  if (!config.defaultProvider) {
    issues.push({ field: 'defaultProvider', message: 'No default provider set', severity: 'error', suggestion: 'Set defaultProvider to one of: github-copilot, gladius' });
  }

  if (!config.defaultModel) {
    issues.push({ field: 'defaultModel', message: 'No default model set', severity: 'error', suggestion: 'Set defaultModel (e.g. "claude-sonnet-4", "gpt-4o")' });
  }

  // Check for contradictory settings
  if (config.providers.anthropic?.apiKey && config.providers.anthropic.apiKey.length < 10) {
    issues.push({ field: 'providers.anthropic.apiKey', message: 'API key looks too short', severity: 'warning', suggestion: 'Anthropic keys start with "sk-ant-" and are ~100+ chars' });
  }



  // Validate temperature
  if (config.temperature < 0 || config.temperature > 2) {
    issues.push({ field: 'temperature', message: `Temperature ${config.temperature} is out of range`, severity: 'error', suggestion: 'Use 0.0–2.0 (recommended: 0.3–0.8)' });
  }

  // Validate maxTokens
  if (config.maxTokens < 1 || config.maxTokens > 1_000_000) {
    issues.push({ field: 'maxTokens', message: `maxTokens ${config.maxTokens} seems wrong`, severity: 'warning', suggestion: 'Typical values: 4096–16384' });
  }

  // Heartbeat validation
  if (config.heartbeat) {
    const hb = config.heartbeat;
    if (hb.quietHoursStart !== undefined && hb.quietHoursEnd !== undefined) {
      if (hb.quietHoursStart < 0 || hb.quietHoursStart > 23 || hb.quietHoursEnd < 0 || hb.quietHoursEnd > 23) {
        issues.push({ field: 'heartbeat.quietHours', message: 'Quiet hours must be 0–23', severity: 'error' });
      }
    }
    if (hb.activeIntervalMin !== undefined && hb.activeIntervalMin < 5) {
      issues.push({ field: 'heartbeat.activeIntervalMin', message: 'Active heartbeat interval < 5min is excessive', severity: 'warning', suggestion: 'Minimum recommended: 15 minutes' });
    }
  }

  // Timeout validation
  if (config.timeouts) {
    for (const [key, val] of Object.entries(config.timeouts)) {
      if (typeof val === 'number' && val < 1000) {
        issues.push({ field: `timeouts.${key}`, message: `Timeout ${val}ms is very low`, severity: 'warning', suggestion: 'Timeouts are in milliseconds. Did you mean seconds?' });
      }
    }
  }

  // Channel account key validation (phone numbers)
  if (config.channels) {
    for (const [name, ch] of Object.entries(config.channels)) {
      if (ch.accountKey && /^\d{10}$/.test(ch.accountKey)) {
        issues.push({
          field: `channels.${name}.accountKey`,
          message: `Account key "${ch.accountKey}" looks like a phone number without country code`,
          severity: 'warning',
          suggestion: `Did you mean "${ch.countryCode ?? '1'}${ch.accountKey}"? Include the country code.`,
        });
      }
    }
  }

  // Budget validation
  if (config.budgets) {
    for (const [resource, budget] of Object.entries(config.budgets)) {
      if (budget.dailyLimit !== undefined && budget.dailyLimit < 1) {
        issues.push({ field: `budgets.${resource}.dailyLimit`, message: 'Daily limit must be >= 1', severity: 'error' });
      }
    }
  }

  return issues;
}

/**
 * Run validation and handle results. Returns true if config is usable.
 * On fatal errors: prints them and returns false (caller should exit).
 */
export function validateAndReport(config: SymbioteConfig): boolean {
  const issues = validateConfig(config);
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  for (const w of warnings) {
    console.warn(`⚠️  Config warning [${w.field}]: ${w.message}${w.suggestion ? `\n   → ${w.suggestion}` : ''}`);
  }

  if (errors.length > 0) {
    console.error('\n❌ Config validation failed:\n');
    for (const e of errors) {
      console.error(`  [${e.field}]: ${e.message}${e.suggestion ? `\n   → ${e.suggestion}` : ''}`);
    }
    console.error(`\n${errors.length} error(s) found. Fix config and retry.\n`);
    return false;
  }

  return true;
}
