import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

export default async function HomePage() {
  const t = await getTranslations('home');

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight text-teal-700">AVIORA</h1>
      <p className="text-lg text-slate-600">{t('tagline')}</p>
      <p className="text-sm text-slate-400">{t('sprintZero')}</p>
      <Link
        href="/sign-in"
        className="rounded-lg bg-teal-700 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-800"
      >
        {t('signIn')}
      </Link>
      <div className="flex gap-3 text-sm">
        <Link href="/" locale="th" className="underline">
          ไทย
        </Link>
        <Link href="/" locale="en" className="underline">
          English
        </Link>
      </div>
    </main>
  );
}
