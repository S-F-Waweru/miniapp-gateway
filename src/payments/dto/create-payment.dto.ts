import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export const ALLOWED_CURRENCIES = ['KES'] as const;

export class CreatePaymentDto {
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  bookingRef!: string;

  // Whole shillings as a string: "1500" = KES 1,500. M-Pesa has no cents, so
  // no decimals; no leading zeros (one spelling per amount); 1 to 12 digits.
  @Matches(/^[1-9]\d{0,11}$/, {
    message: 'amount must be whole shillings as a string, e.g. "1500"',
  })
  amount!: string;

  @IsIn(ALLOWED_CURRENCIES)
  currency!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  customerRef?: string;

  @IsISO8601({ strict: true })
  expiresAt!: string;
}
