/**
 * `/` → `/dashboard` redirect.
 *
 * Auth は middleware が担保しているので、ここではログイン済み前提で
 * S-002 ダッシュボードへハンドオフするだけ。
 */
import { redirect } from 'next/navigation';

export default function HomePage(): never {
  redirect('/dashboard');
}
