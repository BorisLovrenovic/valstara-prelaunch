import { CANADA_COUNTRY_CODE } from '../copy/country.ts';
import { signupFormCopy } from '../copy/signup.ts';
import type { SignupErrorCode } from '../pages/api/signup.ts';

/**
 * Pure logic for the signup form island (E3-05), kept out of the DOM wiring so
 * it can be unit-tested directly. `import type` above is erased at build time,
 * so importing the route's closed-code type pulls no server code into the
 * browser bundle.
 */

export type SignupFieldName = 'email' | 'country' | 'region';

export interface SignupClientError {
  readonly field: SignupFieldName;
  readonly message: string;
}

export interface SignupFieldValues {
  readonly email: string;
  readonly country: string;
  readonly region: string;
}

/**
 * The inline validation the island runs before it sends a request. It blocks
 * only on empty required fields — exactly the states the server also rejects
 * with `invalid_input` (an empty email, no country, or a Canadian signup with no
 * region). It deliberately does **not** judge email *shape*: that is the
 * server's `invalid_email`, so a good address the server would accept is never
 * blocked here. The region rule mirrors the route: required only for Canada.
 */
export function collectClientErrors(
  values: SignupFieldValues,
): SignupClientError[] {
  const errors: SignupClientError[] = [];

  if (values.email.trim() === '') {
    errors.push({ field: 'email', message: signupFormCopy.emailRequired });
  }
  if (values.country.trim() === '') {
    errors.push({ field: 'country', message: signupFormCopy.countryRequired });
  }
  if (
    values.country.trim().toUpperCase() === CANADA_COUNTRY_CODE &&
    values.region.trim() === ''
  ) {
    errors.push({ field: 'region', message: signupFormCopy.regionRequired });
  }

  return errors;
}

/**
 * Where each server error code is surfaced: on the email field when it is about
 * the address, otherwise at form level. Every code in the route's closed set has
 * an entry — a unit test reconciles this map against `signupErrorCatalogue`, so
 * a new code cannot be added without deciding where the island shows it.
 */
export const signupErrorField: Record<SignupErrorCode, 'email' | 'form'> = {
  invalid_input: 'form',
  invalid_email: 'email',
  challenge_failed: 'form',
  rate_limited: 'form',
  unavailable: 'form',
  internal: 'form',
};

/** The field a server error targets, defaulting to form level for anything unmapped. */
export function serverErrorField(code: string): 'email' | 'form' {
  return Object.prototype.hasOwnProperty.call(signupErrorField, code)
    ? signupErrorField[code as SignupErrorCode]
    : 'form';
}
