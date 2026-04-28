import { useState } from 'react';
import * as icons from 'lucide-react';
import { sanitizeSvg } from '../utils/svg';

interface IconPickerProps {
  value: string;
  onChange: (value: string) => void;
}

const LUCIDE_ICONS = Object.keys(icons).filter(key => key !== 'createLucideIcon' && key !== 'LucideProps' && key !== 'Icon');

export default function IconPicker({ value, onChange }: IconPickerProps) {
  const [tab, setTab] = useState<'emoji' | 'lucide' | 'svg'>('emoji');
  const [search, setSearch] = useState('');

  const ICON_PALETTE = [
    '⚡','✨','🪄','🎯','✂️','🧹','🔗','🎨',
    '🌀','✅','📍','📐','↔️','↕️','🔄','📝',
    '🔷','💡','📷','🟦','🔲','👁️','🔒','📦',
  ];

  const handleBrowseSvg = () => {
    if (typeof window.cep === 'undefined') {
      // Fallback for non-CEP environment
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.svg';
      input.onchange = (e: any) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
            if (ev.target?.result) onChange(ev.target.result as string);
          };
          reader.readAsText(file);
        }
      };
      input.click();
      return;
    }
    
    // CEP Environment
    const result = window.cep.fs.showOpenDialog(false, false, "Select SVG Icon", "", ["svg"]);
    if (result.err === 0 && result.data.length > 0) {
      const filePath = result.data[0].replace(/\\/g, "/");
      const readResult = window.cep.fs.readFile(filePath);
      if (readResult.err === 0) {
        onChange(readResult.data);
      }
    }
  };

  const filteredLucide = LUCIDE_ICONS.filter(name => name.toLowerCase().includes(search.toLowerCase())).slice(0, 150);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={{ color: 'var(--panel-fg-muted)', fontSize: '11px', flexShrink: 0 }}>Icon</label>
        
        <input 
          type="text" 
          value={value.startsWith('<svg') ? '(Custom SVG)' : value} 
          placeholder="(optional)" 
          onChange={(e) => {
            if (!value.startsWith('<svg')) {
              onChange(e.target.value);
            }
          }} 
          readOnly={value.startsWith('<svg')}
          style={{ flex: 1, padding: '6px 8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)', textAlign: 'center', fontSize: '14px', textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden' }} 
        />
        {value && (
          <button onClick={() => onChange('')} title="Clear icon" style={{ padding: '4px 8px', backgroundColor: 'transparent', color: 'var(--panel-fg-muted)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '11px' }}>×</button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '4px', backgroundColor: 'var(--panel-bg-sunken)', padding: '4px', borderRadius: 'var(--radius-md)' }}>
        {['emoji', 'lucide', 'svg'].map((t) => (
          <button 
            key={t}
            onClick={() => setTab(t as any)}
            style={{ flex: 1, padding: '4px 0', fontSize: '11px', textTransform: 'uppercase', cursor: 'pointer', border: 'none', backgroundColor: tab === t ? 'var(--accent)' : 'transparent', color: tab === t ? '#fff' : 'var(--panel-fg-muted)', borderRadius: 'var(--radius-sm)' }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'emoji' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '4px', marginTop: '4px' }}>
          {ICON_PALETTE.map((emoji) => {
            const active = value === emoji;
            return (
              <button
                key={emoji}
                onClick={() => onChange(active ? '' : emoji)}
                style={{ padding: '4px 0', backgroundColor: active ? 'var(--accent)' : 'var(--panel-bg-sunken)', border: `1px solid ${active ? 'var(--accent)' : 'var(--panel-border)'}`, borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      )}

      {tab === 'lucide' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
          <input 
            type="text" 
            placeholder="Search icons..." 
            value={search} 
            onChange={(e) => setSearch(e.target.value)} 
            style={{ padding: '4px 8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)', fontSize: '12px' }} 
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '2px', maxHeight: '200px', overflowY: 'auto', paddingRight: '4px' }} className="no-scrollbar">
            {filteredLucide.map((iconName) => {
              const active = value === iconName;
              const IconComp = (icons as any)[iconName];
              return (
                <button
                  key={iconName}
                  onClick={() => onChange(active ? '' : iconName)}
                  title={iconName}
                  style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4px 0', backgroundColor: active ? 'var(--accent)' : 'var(--panel-bg-sunken)', border: `1px solid ${active ? 'var(--accent)' : 'var(--panel-border)'}`, borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: active ? '#fff' : 'var(--panel-fg)' }}
                >
                  {IconComp && <IconComp size={16} />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'svg' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
          <button onClick={handleBrowseSvg} style={{ padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px dashed var(--panel-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '12px' }}>
            Browse SVG File...
          </button>
          {value.startsWith('<svg') && (
            <div style={{ padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'center', alignItems: 'center', height: '40px' }}>
              <div dangerouslySetInnerHTML={{ __html: sanitizeSvg(value) }} style={{ width: '24px', height: '24px', color: 'var(--panel-fg)' }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
