import { registerDecorator, type ValidationOptions } from 'class-validator';

/** A Terms of Service version as the web app names it, e.g. `2026-10-01` or `v3`. */
export const TERMS_VERSION_PATTERN = /^[\w.-]{1,40}$/;

/** Private profile details are a free-form object: capped so it can't be used as file storage. */
export const PROFILE_DETAILS_MAX_BYTES = 20_000;

/** The value is a plain object whose JSON is at most `maxBytes` long. */
export function IsJsonObjectOfSize(
  maxBytes: number,
  options?: ValidationOptions,
): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isJsonObjectOfSize',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `$property must be an object of at most ${maxBytes} bytes`,
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
          ) {
            return false;
          }
          return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
        },
      },
    });
  };
}
