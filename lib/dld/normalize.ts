import type { DldBroker, DldOffice } from "./client";

/**
 * The gateway hands back dates as naive local strings ("2026-06-25T11:57:53")
 * with no zone. Dubai is UTC+4 year-round. We anchor to UTC so day-bucketing in
 * SQL is stable, and treat the placeholder epoch values the registry uses for
 * "unknown" as null.
 */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return null;

  const d = new Date(trimmed.endsWith("Z") ? trimmed : `${trimmed}Z`);
  if (Number.isNaN(d.getTime())) return null;

  const year = d.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;

  return d;
}

/** Trims, and collapses the registry's several spellings of "empty". */
export function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v || v === "-" || v === "0" || v === "null" || v === "undefined") return null;
  // Some rows carry a literal placeholder mobile number.
  if (/^0+$/.test(v) || v === "1000000000") return null;
  return v;
}

/**
 * Phone numbers arrive in a dozen shapes: "971|0506555800", "971-4-4520077",
 * "0568086310", "056 808 6310". Normalise to +971XXXXXXXXX where we can, and
 * otherwise return the cleaned original so nothing is lost.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;

  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  digits = digits.replace(/\D/g, "");

  if (!digits) return null;

  // "971|050..." style: strip the duplicated country code before the local 0.
  if (digits.startsWith("971")) digits = digits.slice(3);
  digits = digits.replace(/^0+/, "");

  if (digits.length < 7 || digits.length > 12) return raw;
  if (/^(\d)\1+$/.test(digits)) return null;

  return `+971${digits}`;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const v = raw.toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

export function normalizeUrl(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.includes(".")) return `https://${raw}`;
  return null;
}

export interface OfficeRow {
  realEstateNumber: string;
  licenseNumber: string | null;
  nameEn: string | null;
  nameAr: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  phone: string | null;
  fax: string | null;
  website: string | null;
  contactNameEn: string | null;
  contactNameAr: string | null;
  contactMobile: string | null;
  contactEmail: string | null;
  logo: string | null;
  rankId: number | null;
  rank: string | null;
  awardsCount: number;
  youtubeUrl: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  twitterUrl: string | null;
  linkedinUrl: string | null;
  whatsapp: string | null;
  activities: Array<{ id: number; nameEn: string | null; nameAr: string | null }>;
}

export function normalizeOffice(o: DldOffice): OfficeRow {
  return {
    realEstateNumber: String(o.RealEstateNumber).trim(),
    licenseNumber: clean(o.LicenseNumber),
    nameEn: clean(o.OfficeNameEn),
    nameAr: clean(o.OfficeNameAr),
    issueDate: parseDate(o.OfficeIssueDate),
    expiryDate: parseDate(o.OfficeExpiryDate),
    phone: normalizePhone(o.OfficePhone),
    fax: clean(o.OfficeFax),
    website: normalizeUrl(o.OfficeWebSite),
    contactNameEn: clean(o.ContactPersonNameEn),
    contactNameAr: clean(o.ContactPersonNameAr),
    contactMobile: normalizePhone(o.ContactPersonMobile),
    contactEmail: normalizeEmail(o.ContactPersonEmail),
    logo: clean(o.OfficeLogo),
    rankId: o.OfficeRankId ?? null,
    rank: clean(o.OfficeRank),
    awardsCount: o.AwardsCount ?? 0,
    youtubeUrl: normalizeUrl(o.YouTubeUrl),
    facebookUrl: normalizeUrl(o.FaceBookUrl),
    instagramUrl: normalizeUrl(o.InstagramUrl),
    twitterUrl: normalizeUrl(o.TwitterUrl),
    linkedinUrl: normalizeUrl(o.LinkedInUrl),
    whatsapp: normalizePhone(o.WhatsAppBusinessNumber),
    activities: (o.Activities ?? []).map((a) => ({
      id: a.ActivityId,
      nameEn: clean(a.ActivityNameEn),
      nameAr: clean(a.ActivityNameAr),
    })),
  };
}

export interface BrokerRow {
  cardNumber: string;
  nameEn: string | null;
  nameAr: string | null;
  cardIssueDate: Date | null;
  cardExpiryDate: Date | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  realEstateNumber: string | null;
  licenseNumber: string | null;
  officeNameEn: string | null;
  officeNameAr: string | null;
  officeIssueDate: Date | null;
  officeExpiryDate: Date | null;
  photo: string | null;
  cardRankId: number | null;
  cardRank: string | null;
  officeRankId: number | null;
  officeRank: string | null;
  awardsCount: number;
}

export function normalizeBroker(b: DldBroker): BrokerRow {
  return {
    cardNumber: String(b.CardNumber).trim(),
    nameEn: clean(b.CardHolderNameEn),
    nameAr: clean(b.CardHolderNameAr),
    cardIssueDate: parseDate(b.CardIssueDate),
    cardExpiryDate: parseDate(b.CardExpiryDate),
    phone: normalizePhone(b.CardHolderPhone),
    mobile: normalizePhone(b.CardHolderMobile),
    email: normalizeEmail(b.CardHolderEmail),
    realEstateNumber: clean(b.RealEstateNumber),
    licenseNumber: clean(b.LicenseNumber),
    officeNameEn: clean(b.OfficeNameEn),
    officeNameAr: clean(b.OfficeNameAr),
    officeIssueDate: parseDate(b.OfficeIssueDate),
    officeExpiryDate: parseDate(b.OfficeExpiryDate),
    photo: clean(b.CardHolderPhoto),
    cardRankId: b.CardRankId ?? null,
    cardRank: clean(b.CardRank),
    officeRankId: b.OfficeRankId ?? null,
    officeRank: clean(b.OfficeRank),
    awardsCount: b.AwardsCount ?? 0,
  };
}
