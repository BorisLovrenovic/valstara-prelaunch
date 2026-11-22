import countryDocument from '../../content/partner-countries.json' with { type: 'json' };
import { normaliseEmail } from '../subscriber/normalise-email.ts';

import {
  partnerApplicationLimits as limits,
  partnerAudienceSizes,
  partnerChannels,
  partnerTypes,
  type PartnerAudienceSize,
  type PartnerChannel,
  type PartnerType,
} from './config.ts';

/**
 * The partner application's fields: exactly the brief's §3.2 list, and no
 * address, phone, payout or tax field (E11.7-05). The form's control names
 * are these keys; the `partner` table's columns mirror them, and a test
 * reconciles the three.
 */
export const partnerApplicationFieldNames = [
  'full_name',
  'email_address',
  'country_of_residence',
  'partner_type',
  'channels',
  'handles',
  'audience_size',
  'promotion_plan',
  'requested_code',
  'age_confirmed',
  'programme_terms_agreed',
  'university',
  'student_email',
  'company_name',
] as const;
export type PartnerApplicationField =
  (typeof partnerApplicationFieldNames)[number];

export interface PartnerCountry {
  readonly code: string;
  readonly name: string;
}

function parseCountries(value: unknown): readonly PartnerCountry[] {
  const countries = (value as { countries?: unknown }).countries;
  if (!Array.isArray(countries) || countries.length === 0) {
    throw new Error('The partner country list is empty.');
  }
  const seen = new Set<string>();
  return Object.freeze(
    countries.map((entry: unknown) => {
      const { code, name } = (entry ?? {}) as Record<string, unknown>;
      if (
        typeof code !== 'string' ||
        !/^[A-Z]{2}$/u.test(code) ||
        typeof name !== 'string' ||
        name.trim() === '' ||
        seen.has(code)
      ) {
        throw new Error('The partner country list has an invalid entry.');
      }
      seen.add(code);
      return Object.freeze({ code, name });
    }),
  );
}

/** The country dropdown, from `src/content/partner-countries.json`. */
export const partnerCountries = parseCountries(countryDocument);
const countryCodes = new Set(partnerCountries.map(({ code }) => code));

/** What the visitor typed, kept as strings so a refused form renders back. */
export interface PartnerApplicationValues {
  readonly fullName: string;
  readonly email: string;
  readonly countryOfResidence: string;
  readonly partnerType: string;
  readonly channels: readonly string[];
  readonly handles: string;
  readonly audienceSize: string;
  readonly promotionPlan: string;
  readonly requestedCode: string;
  readonly ageConfirmed: boolean;
  readonly programmeTermsAgreed: boolean;
  readonly university: string;
  readonly studentEmail: string;
  readonly companyName: string;
}

export const emptyPartnerApplicationValues: PartnerApplicationValues =
  Object.freeze({
    fullName: '',
    email: '',
    countryOfResidence: '',
    partnerType: '',
    channels: Object.freeze([]),
    handles: '',
    audienceSize: '',
    promotionPlan: '',
    requestedCode: '',
    ageConfirmed: false,
    programmeTermsAgreed: false,
    university: '',
    studentEmail: '',
    companyName: '',
  });

/** A validated application, ready to store. */
export interface PartnerApplicationFields {
  readonly fullName: string;
  readonly email: string;
  readonly countryOfResidence: string;
  readonly partnerType: PartnerType;
  readonly channels: readonly PartnerChannel[];
  readonly handles: readonly string[];
  readonly audienceSize: PartnerAudienceSize;
  readonly promotionPlan: string;
  readonly requestedCode: string;
  readonly university: string | null;
  readonly studentEmail: string | null;
  readonly companyName: string | null;
}

/** Why a field was refused; the page maps each to its copy. */
export type PartnerFieldError = 'required' | 'too_long' | 'invalid';

export type PartnerFieldParse =
  | { readonly ok: true; readonly fields: PartnerApplicationFields }
  | {
      readonly ok: false;
      readonly errors: Readonly<
        Partial<Record<PartnerApplicationField, PartnerFieldError>>
      >;
    };

function text(form: FormData, name: PartnerApplicationField): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** Reads the submitted form into strings, ignoring every unknown control. */
export function readPartnerApplicationValues(
  form: FormData,
): PartnerApplicationValues {
  return {
    fullName: text(form, 'full_name'),
    email: text(form, 'email_address'),
    countryOfResidence: text(form, 'country_of_residence'),
    partnerType: text(form, 'partner_type'),
    channels: form
      .getAll('channels')
      .filter((value): value is string => typeof value === 'string'),
    handles: text(form, 'handles'),
    audienceSize: text(form, 'audience_size'),
    promotionPlan: text(form, 'promotion_plan'),
    requestedCode: text(form, 'requested_code'),
    ageConfirmed: form.get('age_confirmed') === 'yes',
    programmeTermsAgreed: form.get('programme_terms_agreed') === 'yes',
    university: text(form, 'university'),
    studentEmail: text(form, 'student_email'),
    companyName: text(form, 'company_name'),
  };
}

/** Handles and links are separated by commas, spaces or new lines. */
export function splitHandles(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((handle) => handle.trim())
    .filter((handle) => handle !== '');
}

function oneOf<Value extends string>(
  allowed: readonly Value[],
  value: string,
): value is Value {
  return (allowed as readonly string[]).includes(value);
}

/**
 * Validates every field except the code's registry rules, which the submit
 * service runs next (E11.7-01). A student ambassador needs a university or
 * college; a student email and a company name stay optional.
 */
export function parsePartnerApplication(
  values: PartnerApplicationValues,
): PartnerFieldParse {
  const errors: Partial<Record<PartnerApplicationField, PartnerFieldError>> =
    {};
  const required = (
    field: PartnerApplicationField,
    value: string,
    maximum: number,
  ): string => {
    const trimmed = value.trim();
    if (trimmed === '') errors[field] = 'required';
    else if (trimmed.length > maximum) errors[field] = 'too_long';
    return trimmed;
  };
  const optional = (
    field: PartnerApplicationField,
    value: string,
    maximum: number,
  ): string | null => {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (trimmed.length > maximum) errors[field] = 'too_long';
    return trimmed;
  };

  const fullName = required('full_name', values.fullName, limits.fullName);
  // The address keeps its exact form: normalisation runs in the service.
  if (values.email === '') errors.email_address = 'required';
  else if (values.email.length > limits.email) {
    errors.email_address = 'too_long';
  }
  if (!countryCodes.has(values.countryOfResidence)) {
    errors.country_of_residence =
      values.countryOfResidence === '' ? 'required' : 'invalid';
  }
  if (!oneOf(partnerTypes, values.partnerType)) {
    errors.partner_type = values.partnerType === '' ? 'required' : 'invalid';
  }
  const channels = [...new Set(values.channels)];
  if (channels.length === 0) errors.channels = 'required';
  else if (!channels.every((channel) => oneOf(partnerChannels, channel))) {
    errors.channels = 'invalid';
  }
  const handles = splitHandles(values.handles);
  if (handles.length === 0) errors.handles = 'required';
  else if (
    handles.length > limits.handles ||
    handles.some((handle) => handle.length > limits.handleLength)
  ) {
    errors.handles = 'too_long';
  }
  if (!oneOf(partnerAudienceSizes, values.audienceSize)) {
    errors.audience_size = values.audienceSize === '' ? 'required' : 'invalid';
  }
  const promotionPlan = required(
    'promotion_plan',
    values.promotionPlan,
    limits.promotionPlan,
  );
  if (values.requestedCode.trim() === '') errors.requested_code = 'required';
  if (!values.ageConfirmed) errors.age_confirmed = 'required';
  if (!values.programmeTermsAgreed) errors.programme_terms_agreed = 'required';

  const university = optional(
    'university',
    values.university,
    limits.university,
  );
  if (values.partnerType === 'student_ambassador' && university === null) {
    errors.university = 'required';
  }
  const studentEmailRaw = optional(
    'student_email',
    values.studentEmail,
    limits.email,
  );
  if (studentEmailRaw !== null && normaliseEmail(studentEmailRaw) === null) {
    errors.student_email = 'invalid';
  }
  const companyName = optional(
    'company_name',
    values.companyName,
    limits.companyName,
  );

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    fields: {
      fullName,
      email: values.email,
      countryOfResidence: values.countryOfResidence,
      partnerType: values.partnerType as PartnerType,
      channels: channels as PartnerChannel[],
      handles,
      audienceSize: values.audienceSize as PartnerAudienceSize,
      promotionPlan,
      requestedCode: values.requestedCode.trim(),
      // A student email and a university are asked of student ambassadors
      // only, so neither is kept for any other type.
      university:
        values.partnerType === 'student_ambassador' ? university : null,
      studentEmail:
        values.partnerType === 'student_ambassador' ? studentEmailRaw : null,
      companyName,
    },
  };
}
