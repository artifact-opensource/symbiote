import { useState, useEffect, type ChangeEvent, type FormEvent } from 'react';
import { X, Plus, Loader2, Check, AlertCircle, Globe, Terminal, FileCode, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';

interface AddAppModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface AppTemplate {
  id: string;
  name: string;
  description: string;
  icon: ReactNode;
  category: 'web' | 'terminal' | 'code' | 'custom';
  defaultPath?: string;
}

const APP_TEMPLATES: AppTemplate[] = [
  {
    id: 'browser',
    name: 'Web Browser',
    description: 'Full-featured web browser with tabs, bookmarks, and dev tools',
    icon: <Globe size={20} />,
    category: 'web',
    defaultPath: 'https://',
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Interactive terminal with multiple tabs and session persistence',
    icon: <Terminal size={20} />,
    category: 'terminal',
  },
  {
    id: 'code-editor',
    name: 'Code Editor',
    description: 'Lightweight code editor with syntax highlighting and live preview',
    icon: <FileCode size={20} />,
    category: 'code',
  },
  {
    id: 'custom',
    name: 'Custom App',
    description: 'Create your own app with a custom path and configuration',
    icon: <Sparkles size={20} />,
    category: 'custom',
  },
];

export default function AddAppModal({ isOpen, onClose }: AddAppModalProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<string>('browser');
  const [customName, setCustomName] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (isOpen) {
      setSelectedTemplate('browser');
      setCustomName('');
      setCustomPath('');
      setError('');
      setSuccess('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setIsCreating(true);

    try {
      if (selectedTemplate === 'custom') {
        if (!customName.trim()) {
          setError('Please enter a name for your custom app');
          setIsCreating(false);
          return;
        }
        if (!customPath.trim()) {
          setError('Please enter a path or URL for your custom app');
          setIsCreating(false);
          return;
        }
      }

      // Simulate app creation
      await new Promise(resolve => setTimeout(resolve, 1000));

      const template = APP_TEMPLATES.find(t => t.id === selectedTemplate);
      const appName = selectedTemplate === 'custom' ? customName.trim() : template?.name || 'New App';

      // Store the app in localStorage for persistence
      const existingApps = JSON.parse(localStorage.getItem('symbiote_apps') || '[]');
      const newApp = {
        id: `app-${Date.now()}`,
        name: appName,
        template: selectedTemplate,
        path: selectedTemplate === 'custom' ? customPath.trim() : template?.defaultPath || '',
        createdAt: new Date().toISOString(),
      };
      existingApps.push(newApp);
      localStorage.setItem('symbiote_apps', JSON.stringify(existingApps));

      setSuccess(`"${appName}" has been added to your apps!`);

      // Reset form after success
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      setError('Failed to create app. Please try again.');
      setIsCreating(false);
    }
  };

  const selectedTemplateData = APP_TEMPLATES.find(t => t.id === selectedTemplate);

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="add-app-title">
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <header className="modal-header">
          <h2 id="add-app-title">Add New App</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close modal">
            <X size={20} />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="modal-body">
          <div className="template-selector">
            <label className="form-label">Choose a template</label>
            <div className="template-grid">
              {APP_TEMPLATES.map(template => (
                <button
                  key={template.id}
                  type="button"
                  className={`template-card${selectedTemplate === template.id ? ' selected' : ''}`}
                  onClick={() => {
                    setSelectedTemplate(template.id);
                    setError('');
                    setSuccess('');
                  }}
                >
                  <div className="template-icon">{template.icon}</div>
                  <div className="template-info">
                    <strong>{template.name}</strong>
                    <small>{template.description}</small>
                  </div>
                  {selectedTemplate === template.id && <Check size={16} className="template-check" />}
                </button>
              ))}
            </div>
          </div>

          {selectedTemplate === 'custom' && (
            <div className="custom-fields">
              <div className="form-field">
                <label htmlFor="custom-name" className="form-label">App Name</label>
                <input
                  id="custom-name"
                  type="text"
                  value={customName}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setCustomName(e.target.value)}
                  placeholder="My Custom App"
                  className="form-input"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="custom-path" className="form-label">Path / URL</label>
                <input
                  id="custom-path"
                  type="text"
                  value={customPath}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setCustomPath(e.target.value)}
                  placeholder="https://example.com or /path/to/app"
                  className="form-input"
                  required
                />
              </div>
            </div>
          )}

          {selectedTemplate !== 'custom' && selectedTemplateData && (
            <div className="template-preview">
              <div className="preview-label">Will create:</div>
              <div className="preview-item">
                <span>{selectedTemplateData.icon}</span>
                <span><strong>{selectedTemplateData.name}</strong></span>
              </div>
              {selectedTemplateData.defaultPath && (
                <div className="preview-path">Default path: <code>{selectedTemplateData.defaultPath}</code></div>
              )}
            </div>
          )}

          {error && <div className="modal-error"><AlertCircle size={16} />{error}</div>}
          {success && <div className="modal-success"><Check size={16} />{success}</div>}

          <div className="modal-actions">
            <button type="button" className="button button-secondary" onClick={onClose} disabled={isCreating}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={isCreating}>
              {isCreating ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
              {isCreating ? 'Adding...' : 'Add App'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
