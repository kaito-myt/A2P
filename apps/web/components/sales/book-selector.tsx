'use client';

/**
 * BookSelector — 書籍選択コンポーネント (S-018, T-08-06).
 *
 * フィルタリング可能な select。タイトルまたは ASIN で検索できる。
 */
import { useState, useRef, useEffect, useId } from 'react';

import { messages } from '@/lib/messages';
import type { BookSelectorItem } from '@/lib/sales-view';
import { cn } from '@/lib/cn';

const m = messages.salesManual.selector;

interface BookSelectorProps {
  books: BookSelectorItem[];
  value: string;
  onChange: (bookId: string) => void;
}

export function BookSelector({ books, value, onChange }: BookSelectorProps) {
  const labelId = useId();
  const inputId = useId();
  const listboxId = useId();

  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedBook = books.find((b) => b.id === value);

  const filtered = query.trim() === ''
    ? books
    : books.filter((b) =>
        b.label.toLowerCase().includes(query.toLowerCase()),
      );

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        if (!selectedBook) setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [selectedBook]);

  function handleInputFocus() {
    setIsOpen(true);
    if (selectedBook) setQuery('');
  }

  function handleSelect(book: BookSelectorItem) {
    onChange(book.id);
    setQuery('');
    setIsOpen(false);
  }

  function handleClear() {
    onChange('');
    setQuery('');
    setIsOpen(false);
  }

  const displayValue = isOpen ? query : (selectedBook?.label ?? query);

  return (
    <div ref={containerRef} className="relative">
      <label
        id={labelId}
        htmlFor={inputId}
        className="mb-1 block text-label text-foreground"
      >
        {m.bookLabel}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          aria-labelledby={labelId}
          aria-autocomplete="list"
          value={displayValue}
          placeholder={m.bookSearchPlaceholder}
          className={cn(
            'w-full rounded-card border border-border-warm bg-cream px-3 py-2 text-body-sm text-charcoal',
            'placeholder:text-muted',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
            if (e.target.value === '') onChange('');
          }}
          onFocus={handleInputFocus}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setIsOpen(false);
              if (!selectedBook) setQuery('');
            }
          }}
          data-testid="book-selector-input"
        />
        {selectedBook && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="書籍の選択をクリア"
            className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-muted hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon />
          </button>
        )}
      </div>
      {isOpen && filtered.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={m.bookLabel}
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-card border border-border-warm bg-cream shadow-l2-inset"
          data-testid="book-selector-listbox"
        >
          {filtered.map((book) => (
            <li
              key={book.id}
              role="option"
              aria-selected={book.id === value}
              className={cn(
                'cursor-pointer px-3 py-2 text-body-sm text-charcoal hover:bg-charcoal-04',
                book.id === value && 'bg-charcoal-04 font-medium',
              )}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur before click
                handleSelect(book);
              }}
            >
              {book.label}
            </li>
          ))}
        </ul>
      )}
      {isOpen && filtered.length === 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-card border border-border-warm bg-cream px-3 py-2 text-body-sm text-muted shadow-l2-inset">
          該当する書籍はありません
        </div>
      )}
    </div>
  );
}

function XIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
