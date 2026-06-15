'use client';

/**
 * SecretField (docs/04 §6.4 / S-004)。
 *
 * 既存値は ●●●● マスク表示。「再入力」ボタン押下で input が現れて編集可能になる。
 * 「マスクに戻す」で入力値はクリアされ、親フォームには「変更なし」のサインを送る。
 *
 * 親フォームへの値の渡し方:
 * - 入力モード OFF: name 付き input は出力されない (= フォーム送信時に key が存在しない)
 * - 入力モード ON: name 付き input を出力 (= フォーム送信時に key が含まれる)
 *
 * これにより、サーバー側は「key 不在 = 変更しない」「key 存在 = 上書き」と
 * 単純に判定できる。
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { messages } from '@/lib/messages';

interface SecretFieldProps {
  name: string;
  label: string;
  type?: 'text' | 'password' | 'email';
  /** 既存値がある場合は true (実値ではなく boolean のみを受け渡す)。 */
  hasExistingValue: boolean;
  /** input の追加属性 (placeholder 等)。 */
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
}

export function SecretField({
  name,
  label,
  type = 'text',
  hasExistingValue,
  inputProps,
}: SecretFieldProps) {
  const m = messages.accounts.detail;
  const [editing, setEditing] = useState(!hasExistingValue);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-button-sm font-normal text-charcoal-83">{label}</label>
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <Input
              type={type}
              name={name}
              autoComplete="off"
              {...inputProps}
              className="flex-1"
            />
            {hasExistingValue && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditing(false)}
              >
                {m.cancelReplaceLabel}
              </Button>
            )}
          </>
        ) : (
          <>
            <span
              className="flex h-10 flex-1 items-center rounded-default border border-border-warm bg-cream px-3 text-body text-muted"
              aria-label={`${label} (マスク表示)`}
            >
              {m.maskedValue}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              {m.replaceLabel}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
