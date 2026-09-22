import { useEffect, useRef, useState } from 'react';
import { SelectionActions } from '../../components/selection-actions';
import { attachFileTouchSelection } from './file-touch-selection';

export function PhoneFileText({ content }: { content: string }) {
  const source = useRef<HTMLPreElement>(null);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    const element = source.current;
    if (!element) return;
    setSelected('');
    return attachFileTouchSelection(element, setSelected);
  }, [content]);
  return (
    <div className="relative min-h-0 flex-1">
      <div className="h-full overflow-auto overscroll-contain">
        <pre ref={source} className="phone-file-source" tabIndex={0}>
          {content}
        </pre>
      </div>
      {selected && (
        <SelectionActions
          label="Selected file text"
          text={selected}
          clear={() => {
            window.getSelection()?.removeAllRanges();
            setSelected('');
          }}
        />
      )}
    </div>
  );
}
