'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  COUPON_KINDS,
  INTERVAL_UNITS,
  OFFERING_KINDS,
  type Coupon,
  type CouponKind,
  type CouponsResponse,
  type IntervalUnit,
  type MembershipPlan,
  type Offering,
  type OfferingKind,
  type OfferingsResponse,
  type PlansResponse,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatMoney } from '@/lib/format';

/** Matches the API's code rule, so the mistake is caught before the request. */
const OFFERING_CODE_PATTERN = '[a-z0-9-]{2,40}';
const COUPON_CODE_PATTERN = '[A-Za-z0-9-]{3,40}';
const CURRENCY_PATTERN = '[A-Z]{3}';

export function CommerceTab() {
  const t = useTranslations('admin.commerce');
  const ts = useTranslations('shop');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Offering form
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<OfferingKind>('one_time');
  const [currency, setCurrency] = useState('');
  const [priceMinor, setPriceMinor] = useState('');
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('month');
  const [intervalCount, setIntervalCount] = useState('1');
  const [savingOffering, setSavingOffering] = useState(false);
  const [offeringError, setOfferingError] = useState<string | null>(null);
  const [offeringCreated, setOfferingCreated] = useState<string | null>(null);

  // Plan price form
  const [planPriceOffering, setPlanPriceOffering] = useState('');
  const [planPricePlan, setPlanPricePlan] = useState('');
  const [planPriceMinor, setPlanPriceMinor] = useState('');
  const [savingPlanPrice, setSavingPlanPrice] = useState(false);
  const [planPriceError, setPlanPriceError] = useState<string | null>(null);
  const [planPriceSaved, setPlanPriceSaved] = useState(false);

  // Coupon form
  const [couponCode, setCouponCode] = useState('');
  const [couponKind, setCouponKind] = useState<CouponKind>('percent');
  const [couponValue, setCouponValue] = useState('');
  const [minSubtotalMinor, setMinSubtotalMinor] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [savingCoupon, setSavingCoupon] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponCreated, setCouponCreated] = useState<string | null>(null);

  const loadOfferings = useCallback(async () => {
    const res = await api.get<OfferingsResponse>('/offerings');
    setOfferings(res.offerings);
  }, []);

  const loadCoupons = useCallback(async () => {
    const res = await api.get<CouponsResponse>('/coupons');
    setCoupons(res.coupons);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Plans only feed the membership-pricing form; not having them must not
    // hide the catalogue.
    api
      .get<PlansResponse>('/membership-plans')
      .then((res) => {
        if (!cancelled) setPlans(res.plans);
      })
      .catch(() => undefined);

    Promise.all([loadOfferings(), loadCoupons()])
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

  const handleCreateOffering = async (e: FormEvent) => {
    e.preventDefault();
    setOfferingError(null);
    setOfferingCreated(null);
    setSavingOffering(true);
    try {
      const body: Record<string, unknown> = {
        code,
        name,
        kind,
        // Minor units only — the field is an integer all the way to the API.
        priceMinor: Number(priceMinor),
      };
      if (description) body.description = description;
      if (currency) body.currency = currency.toUpperCase();
      if (kind === 'subscription') {
        body.intervalUnit = intervalUnit;
        body.intervalCount = Number(intervalCount);
      }
      await api.post('/offerings', body);
      setOfferingCreated(name);
      setCode('');
      setName('');
      setDescription('');
      setCurrency('');
      setPriceMinor('');
      await loadOfferings();
    } catch (err: unknown) {
      if (isForbidden(err)) setOfferingError(t('forbidden'));
      else setOfferingError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingOffering(false);
    }
  };

  const handleSetPlanPrice = async (e: FormEvent) => {
    e.preventDefault();
    setPlanPriceError(null);
    setPlanPriceSaved(false);
    setSavingPlanPrice(true);
    try {
      await api.put(`/offerings/${planPriceOffering}/plan-price`, {
        planId: planPricePlan,
        priceMinor: Number(planPriceMinor),
      });
      setPlanPriceSaved(true);
      setPlanPriceMinor('');
      // The catalogue shows the CALLER's resolved price, so a plan price the
      // admin does not hold will not change this table — reload anyway, because
      // it does change when the admin is on that plan.
      await loadOfferings();
    } catch (err: unknown) {
      if (isForbidden(err)) setPlanPriceError(t('forbidden'));
      else setPlanPriceError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingPlanPrice(false);
    }
  };

  const handleCreateCoupon = async (e: FormEvent) => {
    e.preventDefault();
    setCouponError(null);
    setCouponCreated(null);
    setSavingCoupon(true);
    try {
      const body: Record<string, unknown> = {
        code: couponCode,
        kind: couponKind,
        value: Number(couponValue),
      };
      if (minSubtotalMinor) body.minSubtotalMinor = Number(minSubtotalMinor);
      if (startsAt) body.startsAt = startsAt;
      if (endsAt) body.endsAt = endsAt;
      if (maxRedemptions) body.maxRedemptions = Number(maxRedemptions);
      await api.post('/coupons', body);
      setCouponCreated(couponCode.toUpperCase());
      setCouponCode('');
      setCouponValue('');
      setMinSubtotalMinor('');
      setStartsAt('');
      setEndsAt('');
      setMaxRedemptions('');
      await loadCoupons();
    } catch (err: unknown) {
      if (isForbidden(err)) setCouponError(t('forbidden'));
      else setCouponError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setSavingCoupon(false);
    }
  };

  const kindLabel = (value: string): string =>
    (OFFERING_KINDS as readonly string[]).includes(value) ? t(`kinds.${value}`) : value;

  const couponAmount = (coupon: Coupon): string => {
    if (coupon.kind === 'percent') return t('percentValue', { value: coupon.value });
    // A fixed coupon carries its own currency. Without one there is no honest
    // way to format it, so the raw minor amount stands rather than a guess.
    return coupon.currency
      ? formatMoney(coupon.value, coupon.currency, locale)
      : String(coupon.value);
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card title={t('offeringsTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('offeringsHint')}</p>
        {forbidden ? (
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        ) : loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : offerings.length === 0 ? (
          <p className="text-sm text-slate-500">{t('offeringsEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[20rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th scope="col" className="py-2 pe-3 font-semibold">
                    {t('name')}
                  </th>
                  <th scope="col" className="py-2 pe-3 font-semibold">
                    {t('kind')}
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    {t('price')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {offerings.map((offering) => (
                  <tr key={offering.id}>
                    <td className="py-2 pe-3 text-slate-800">
                      <span className="block break-words">{offering.name}</span>
                      <span className="block break-all text-xs text-slate-500">
                        {offering.code}
                      </span>
                    </td>
                    <td className="py-2 pe-3 text-slate-600">{kindLabel(offering.kind)}</td>
                    <td className="py-2 font-semibold text-slate-900">
                      {formatMoney(offering.listPriceMinor, offering.currency, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {forbidden ? null : (
        <>
          <Card title={t('formTitle')}>
            <form onSubmit={handleCreateOffering} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label={t('code')}
                required
                pattern={OFFERING_CODE_PATTERN}
                hint={t('codeHint')}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Input
                label={t('name')}
                required
                maxLength={160}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label={t('description')}
                maxLength={2000}
                className="sm:col-span-2"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <Select
                label={t('kind')}
                value={kind}
                onChange={(e) => setKind(e.target.value as OfferingKind)}
              >
                {OFFERING_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {t(`kinds.${option}`)}
                  </option>
                ))}
              </Select>
              <Input
                label={t('currency')}
                pattern={CURRENCY_PATTERN}
                maxLength={3}
                hint={t('currencyHint')}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
              <Input
                label={t('priceMinorInput')}
                type="number"
                min="0"
                max="1000000000"
                step="1"
                inputMode="numeric"
                required
                hint={t('priceHint')}
                className="sm:col-span-2"
                value={priceMinor}
                onChange={(e) => setPriceMinor(e.target.value)}
              />
              {kind === 'subscription' ? (
                <>
                  <Select
                    label={t('intervalUnit')}
                    value={intervalUnit}
                    onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                  >
                    {INTERVAL_UNITS.map((option) => (
                      <option key={option} value={option}>
                        {ts(`unit${option.charAt(0).toUpperCase()}${option.slice(1)}`)}
                      </option>
                    ))}
                  </Select>
                  <Input
                    label={t('intervalCount')}
                    type="number"
                    min="1"
                    max="365"
                    step="1"
                    inputMode="numeric"
                    required
                    value={intervalCount}
                    onChange={(e) => setIntervalCount(e.target.value)}
                  />
                </>
              ) : null}
              {offeringError ? (
                <p className="text-sm text-red-600 sm:col-span-2">{offeringError}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <Button type="submit" disabled={savingOffering}>
                  {savingOffering ? tc('saving') : t('submitOffering')}
                </Button>
                {offeringCreated ? (
                  <span className="text-sm text-teal-700">
                    {t('offeringCreated', { name: offeringCreated })}
                  </span>
                ) : null}
              </div>
            </form>
          </Card>

          <Card title={t('planPriceTitle')}>
            <p className="mb-3 text-xs text-slate-500">{t('planPriceHint')}</p>
            {offerings.length === 0 || plans.length === 0 ? (
              <p className="text-sm text-slate-500">{t('planPriceUnavailable')}</p>
            ) : (
              <form onSubmit={handleSetPlanPrice} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                  label={t('offering')}
                  required
                  value={planPriceOffering}
                  onChange={(e) => setPlanPriceOffering(e.target.value)}
                >
                  <option value="">{t('choose')}</option>
                  {offerings.map((offering) => (
                    <option key={offering.id} value={offering.id}>
                      {offering.name}
                    </option>
                  ))}
                </Select>
                <Select
                  label={t('plan')}
                  required
                  value={planPricePlan}
                  onChange={(e) => setPlanPricePlan(e.target.value)}
                >
                  <option value="">{t('choose')}</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
                </Select>
                <Input
                  label={t('priceMinorInput')}
                  type="number"
                  min="0"
                  max="1000000000"
                  step="1"
                  inputMode="numeric"
                  required
                  hint={t('priceHint')}
                  className="sm:col-span-2"
                  value={planPriceMinor}
                  onChange={(e) => setPlanPriceMinor(e.target.value)}
                />
                {planPriceError ? (
                  <p className="text-sm text-red-600 sm:col-span-2">{planPriceError}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                  <Button type="submit" disabled={savingPlanPrice}>
                    {savingPlanPrice ? tc('saving') : t('submitPlanPrice')}
                  </Button>
                  {planPriceSaved ? (
                    <span className="text-sm text-teal-700">{t('planPriceSaved')}</span>
                  ) : null}
                </div>
              </form>
            )}
          </Card>
        </>
      )}

      <Card title={t('couponsTitle')}>
        <p className="mb-3 text-xs text-slate-500">{t('couponsHint')}</p>
        {forbidden ? (
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        ) : loading ? (
          <p className="text-sm text-slate-500">{tc('loading')}</p>
        ) : coupons.length === 0 ? (
          <p className="text-sm text-slate-500">{t('couponsEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[20rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th scope="col" className="py-2 pe-3 font-semibold">
                    {t('couponCode')}
                  </th>
                  <th scope="col" className="py-2 pe-3 font-semibold">
                    {t('couponValue')}
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    {t('redeemed')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {coupons.map((coupon) => (
                  <tr key={coupon.id}>
                    <td className="py-2 pe-3">
                      <span className="block break-all text-slate-800">{coupon.code}</span>
                      {coupon.status !== 'active' ? (
                        <Badge tone="gray">{coupon.status}</Badge>
                      ) : null}
                    </td>
                    <td className="py-2 pe-3 font-semibold text-slate-900">
                      {couponAmount(coupon)}
                    </td>
                    <td className="py-2 text-slate-600">
                      {coupon.maxRedemptions === null
                        ? coupon.redeemedCount
                        : `${coupon.redeemedCount} / ${coupon.maxRedemptions}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {forbidden ? null : (
        <Card title={t('couponFormTitle')}>
          <form onSubmit={handleCreateCoupon} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label={t('couponCode')}
              required
              pattern={COUPON_CODE_PATTERN}
              hint={t('couponCodeHint')}
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value)}
            />
            <Select
              label={t('couponKind')}
              value={couponKind}
              onChange={(e) => setCouponKind(e.target.value as CouponKind)}
            >
              {COUPON_KINDS.map((option) => (
                <option key={option} value={option}>
                  {t(`couponKinds.${option}`)}
                </option>
              ))}
            </Select>
            <Input
              label={t('couponValue')}
              type="number"
              min="1"
              max={couponKind === 'percent' ? '100' : '1000000000'}
              step="1"
              inputMode="numeric"
              required
              hint={couponKind === 'percent' ? t('percentHint') : t('priceHint')}
              value={couponValue}
              onChange={(e) => setCouponValue(e.target.value)}
            />
            <Input
              label={t('minSubtotal')}
              type="number"
              min="0"
              max="1000000000"
              step="1"
              inputMode="numeric"
              hint={t('priceHint')}
              value={minSubtotalMinor}
              onChange={(e) => setMinSubtotalMinor(e.target.value)}
            />
            <Input
              label={t('startsAt')}
              type="date"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
            <Input
              label={t('endsAt')}
              type="date"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
            <Input
              label={t('maxRedemptions')}
              type="number"
              min="1"
              max="1000000"
              step="1"
              inputMode="numeric"
              className="sm:col-span-2"
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
            />
            {couponError ? (
              <p className="text-sm text-red-600 sm:col-span-2">{couponError}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={savingCoupon}>
                {savingCoupon ? tc('saving') : t('submitCoupon')}
              </Button>
              {couponCreated ? (
                <span className="text-sm text-teal-700">
                  {t('couponCreated', { code: couponCreated })}
                </span>
              ) : null}
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
