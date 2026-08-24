'use client';

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden, issueFor, validationIssues } from '@/lib/api-client';
import {
  BRANDING_COLOR_TOKENS,
  fontStack,
  HIDEABLE_FEATURES,
  isBrandingColor,
  toLanding,
  type BrandingColorToken,
  type BrandingLandingSection,
  type BrandingResponse,
  type BrandingUpdateResponse,
  type BrandingView,
} from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';

/** What a colour input starts at when the tenant has never set that token. */
const COLOR_FALLBACKS: Record<BrandingColorToken, string> = {
  primary: '#0f766e',
  onPrimary: '#ffffff',
  accent: '#f59e0b',
  surface: '#ffffff',
  text: '#0f172a',
};

type ColorDraft = Record<BrandingColorToken, string>;

function colorDraft(colors: Record<string, string>): ColorDraft {
  const draft = {} as ColorDraft;
  for (const token of BRANDING_COLOR_TOKENS) {
    const value = colors[token];
    draft[token] = value && isBrandingColor(value) ? value : COLOR_FALLBACKS[token];
  }
  return draft;
}

/**
 * White label, as configuration (docs/29 §1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The hidden-features picker saves a list of navigation keys, and NOTHING on
 * this screen or behind it treats that list as a permission. It is stated on
 * the screen too, in the tenant's own language, beside the picker — because
 * this is the mistake the feature invites, and an administrator who believes
 * they have "turned off" a feature has been misled by the software.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything a tenant supplies here is DATA: colours from a colour input, a
 * font NAME from the server's own allow-list, and plain-text copy. No CSS and
 * no markup — a stylesheet is code, and a tenant shipping code into another
 * member's browser is script injection wearing a brand.
 */
export function BrandingTab() {
  const t = useTranslations('admin.branding');
  const tc = useTranslations('common');

  const [branding, setBranding] = useState<BrandingView | null>(null);
  const [fontFamilies, setFontFamilies] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [appName, setAppName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [fontFamily, setFontFamily] = useState('');
  const [colors, setColors] = useState<ColorDraft>(() => colorDraft({}));

  const [headline, setHeadline] = useState('');
  const [subheadline, setSubheadline] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');
  const [ctaHref, setCtaHref] = useState('');
  /**
   * Landing sections are round-tripped untouched. This screen edits the four
   * lines a tenant actually rewrites; silently dropping the rest on save would
   * delete copy nobody asked to delete.
   */
  const [sections, setSections] = useState<BrandingLandingSection[]>([]);

  const [emailFromName, setEmailFromName] = useState('');
  const [emailFooter, setEmailFooter] = useState('');
  /**
   * `GET /tenant/branding` does not return the email sender or footer, so this
   * screen cannot show what is stored. It therefore sends them only when the
   * administrator has actually touched the field — an untouched empty box means
   * "leave whatever is there", never "erase it".
   */
  const [emailTouched, setEmailTouched] = useState(false);

  const [hidden, setHidden] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ReturnType<typeof validationIssues>>([]);

  const applyBranding = (view: BrandingView) => {
    setBranding(view);
    setAppName(view.appName);
    setLogoUrl(view.logoUrl ?? '');
    setFontFamily(view.fontFamily ?? '');
    setColors(colorDraft(view.colors));
    const landing = toLanding(view.landing);
    setHeadline(landing.headline ?? '');
    setSubheadline(landing.subheadline ?? '');
    setCtaLabel(landing.ctaLabel ?? '');
    setCtaHref(landing.ctaHref ?? '');
    setSections(landing.sections ?? []);
    setHidden(view.hiddenFeatures);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .get<BrandingResponse>('/tenant/branding')
      .then((res) => {
        if (cancelled) return;
        applyBranding(res.branding);
        setFontFamilies(res.fontFamilies);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Keys the workspace already hides that this build has no name for — set by
   * another tool, or by a later version. They stay ticked and stay saved: the
   * update replaces the whole list, so dropping them here would quietly undo
   * somebody's choice.
   */
  const unknownHidden = useMemo(
    () => hidden.filter((key) => !(HIDEABLE_FEATURES as readonly string[]).includes(key)),
    [hidden],
  );

  const toggleHidden = (key: string) =>
    setHidden((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));

  const setColor = (token: BrandingColorToken, value: string) =>
    setColors((draft) => ({ ...draft, [token]: value }));

  /**
   * The preview's colours become CSS custom properties, exactly as the contract
   * describes them being applied to a tenant's pages — and every value has
   * already been checked as a colour, so nothing but a colour reaches a style.
   */
  const previewStyle = useMemo(() => {
    const style: Record<string, string> = {};
    for (const token of BRANDING_COLOR_TOKENS) {
      const value = colors[token];
      if (isBrandingColor(value)) style[`--brand-${token}`] = value;
    }
    const stack = fontStack(fontFamily);
    if (stack) style.fontFamily = stack;
    return style as CSSProperties;
  }, [colors, fontFamily]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setIssues([]);
    setSaved(false);
    setSaving(true);
    try {
      const landing: Record<string, unknown> = {};
      if (headline) landing.headline = headline;
      if (subheadline) landing.subheadline = subheadline;
      if (ctaLabel) landing.ctaLabel = ctaLabel;
      // An empty string is not a URL and the API would refuse it; omitting the
      // key is how "no call to action link" is expressed.
      if (ctaHref) landing.ctaHref = ctaHref;
      if (sections.length > 0) landing.sections = sections;

      const body: Record<string, unknown> = {
        appName: appName || null,
        logoUrl: logoUrl || null,
        colors,
        fontFamily: fontFamily || null,
        landing,
        hiddenFeatures: hidden,
      };
      if (emailTouched) {
        body.emailFromName = emailFromName || null;
        body.emailFooter = emailFooter || null;
      }

      const res = await api.put<BrandingUpdateResponse>('/tenant/branding', body);
      applyBranding(res.branding);
      setEmailTouched(false);
      setSaved(true);
    } catch (err: unknown) {
      if (isForbidden(err)) setSaveError(t('forbidden'));
      else {
        setIssues(validationIssues(err));
        setSaveError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      }
    } finally {
      setSaving(false);
    }
  };

  const featureLabel = (key: string): string =>
    (HIDEABLE_FEATURES as readonly string[]).includes(key) ? t(`features.${key}`) : key;

  if (loading) return <p className="text-sm text-slate-500">{tc('loading')}</p>;
  if (forbidden) return <p className="text-sm text-slate-600">{t('forbidden')}</p>;

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <form onSubmit={handleSave} className="flex flex-col gap-4">
        <Card title={t('identityTitle')}>
          <p className="mb-3 text-xs text-slate-500">{t('identityHint')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label={t('appName')}
              maxLength={80}
              value={appName}
              error={issueFor(issues, 'appName')}
              onChange={(e) => setAppName(e.target.value)}
            />
            <Input
              label={t('logoUrl')}
              type="url"
              inputMode="url"
              maxLength={2048}
              hint={t('logoUrlHint')}
              value={logoUrl}
              error={issueFor(issues, 'logoUrl')}
              onChange={(e) => setLogoUrl(e.target.value)}
            />
            <Select
              label={t('fontFamily')}
              className="sm:col-span-2"
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
            >
              {/* The families come from the server, so this can never offer one
                  the API would refuse. */}
              <option value="">{t('fontInherit')}</option>
              {fontFamilies.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500 sm:col-span-2">{t('fontHint')}</p>
          </div>
        </Card>

        <Card title={t('coloursTitle')}>
          <p className="mb-3 text-xs text-slate-500">{t('coloursHint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {BRANDING_COLOR_TOKENS.map((token) => (
              <label key={token} className="flex items-center gap-3">
                <input
                  type="color"
                  value={colors[token]}
                  onChange={(e) => setColor(token, e.target.value)}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded border border-slate-300 bg-white"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-slate-700">
                    {t(`colours.${token}`)}
                  </span>
                  <span className="break-all font-mono text-xs text-slate-500">
                    {colors[token]}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {issueFor(issues, 'colors') ? (
            <p className="mt-2 text-xs text-red-600">{issueFor(issues, 'colors')}</p>
          ) : null}

          <div className="mt-4">
            <p className="mb-2 text-sm font-semibold text-slate-800">{t('previewTitle')}</p>
            <div
              style={previewStyle}
              className="rounded-xl border border-slate-200 p-4"
              // Not a live tenant page — a rehearsal of one, so it is announced
              // as a preview rather than left to look like the real thing.
              aria-label={t('previewTitle')}
            >
              <div
                className="rounded-lg p-4"
                style={{ background: 'var(--brand-surface)', color: 'var(--brand-text)' }}
              >
                <p className="break-words text-lg font-bold">{appName || t('previewAppName')}</p>
                <p className="mt-1 break-words text-sm opacity-80">
                  {headline || t('previewHeadline')}
                </p>
                <span
                  className="mt-3 inline-flex rounded-lg px-4 py-2 text-sm font-medium"
                  style={{ background: 'var(--brand-primary)', color: 'var(--brand-onPrimary)' }}
                >
                  {ctaLabel || t('previewCta')}
                </span>
                <span
                  className="ms-2 mt-3 inline-flex rounded-lg px-3 py-2 text-sm font-medium"
                  style={{ background: 'var(--brand-accent)', color: 'var(--brand-onPrimary)' }}
                >
                  {t('previewAccent')}
                </span>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-500">{t('previewNote')}</p>
          </div>
        </Card>

        <Card title={t('landingTitle')}>
          <p className="mb-3 text-xs text-slate-500">{t('landingHint')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label={t('headline')}
              maxLength={160}
              className="sm:col-span-2"
              value={headline}
              error={issueFor(issues, 'landing.headline')}
              onChange={(e) => setHeadline(e.target.value)}
            />
            <Textarea
              label={t('subheadline')}
              maxLength={320}
              rows={3}
              className="sm:col-span-2"
              value={subheadline}
              error={issueFor(issues, 'landing.subheadline')}
              onChange={(e) => setSubheadline(e.target.value)}
            />
            <Input
              label={t('ctaLabel')}
              maxLength={60}
              value={ctaLabel}
              error={issueFor(issues, 'landing.ctaLabel')}
              onChange={(e) => setCtaLabel(e.target.value)}
            />
            <Input
              label={t('ctaHref')}
              type="url"
              inputMode="url"
              maxLength={2048}
              hint={t('ctaHrefHint')}
              value={ctaHref}
              error={issueFor(issues, 'landing.ctaHref')}
              onChange={(e) => setCtaHref(e.target.value)}
            />
            {sections.length > 0 ? (
              <p className="text-xs text-slate-500 sm:col-span-2">
                {t('sectionsKept', { count: sections.length })}
              </p>
            ) : null}
          </div>
        </Card>

        <Card title={t('emailTitle')}>
          <p className="mb-3 text-xs text-slate-500">{t('emailHint')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label={t('emailFromName')}
              maxLength={80}
              className="sm:col-span-2"
              value={emailFromName}
              error={issueFor(issues, 'emailFromName')}
              onChange={(e) => {
                setEmailTouched(true);
                setEmailFromName(e.target.value);
              }}
            />
            <Textarea
              label={t('emailFooter')}
              maxLength={600}
              rows={3}
              className="sm:col-span-2"
              value={emailFooter}
              error={issueFor(issues, 'emailFooter')}
              onChange={(e) => {
                setEmailTouched(true);
                setEmailFooter(e.target.value);
              }}
            />
          </div>
        </Card>

        <Card title={t('hiddenTitle')}>
          {/*
            The picker and the sentence beside it are one thing. Anybody who can
            reach this control has to read what it does NOT do.
          */}
          <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm font-semibold text-amber-900">{t('hiddenNoticeTitle')}</p>
            <p className="mt-1 text-sm text-amber-900">{t('hiddenNotice')}</p>
            {branding ? (
              <p className="mt-2 break-words text-xs text-amber-800">
                {t('hiddenNoteFromApi')} “{branding.hiddenFeaturesNote}”
              </p>
            ) : null}
          </div>
          <p className="mb-3 text-xs text-slate-500">{t('hiddenHint')}</p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {HIDEABLE_FEATURES.map((key) => (
              <li key={key}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={hidden.includes(key)}
                    onChange={() => toggleHidden(key)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
                  />
                  <span className="min-w-0 break-words text-sm text-slate-700">
                    {featureLabel(key)}
                  </span>
                </label>
              </li>
            ))}
            {unknownHidden.map((key) => (
              <li key={key}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked
                    onChange={() => toggleHidden(key)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
                  />
                  <span className="min-w-0 break-all text-sm text-slate-700">
                    {key} <span className="text-xs text-slate-500">({t('unknownFeature')})</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {issueFor(issues, 'hiddenFeatures') ? (
            <p className="mt-2 text-xs text-red-600">{issueFor(issues, 'hiddenFeatures')}</p>
          ) : null}
        </Card>

        {saveError ? <p className="text-sm text-red-600">{saveError}</p> : null}
        {issues.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`} className="break-words text-xs text-red-600">
                {issue.path ? `${issue.path}: ` : ''}
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? tc('saving') : t('submit')}
          </Button>
          {saved ? <span className="text-sm text-brand-700">{t('savedNote')}</span> : null}
        </div>
      </form>
    </div>
  );
}
