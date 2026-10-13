// Paste your Supabase project's details here (Dashboard → Connect, or Project Settings → API Keys).
// Use the Project URL on its own (https://xxxx.supabase.co) and the publishable
// (sb_publishable_...) or legacy anon key. Never use a secret / service_role key.
// This key is meant to be public: the security rules in supabase/schema.sql
// are what protect your data, so only signed-in staff can see bookings.

export const SUPABASE_URL = "https://embkujshqombiawjcuqz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_NUwkz3MVvkPdOhW1SjmZgA_u-qmMPp_";

// Your business name, shown at the top of the app and on the login screen.
export const BUSINESS_NAME = "Booking Register";

// Options in the Booking Type list. Edit freely.
export const BOOKING_TYPES = [
  "Direct",
  "Walk-in",
  "Phone / WhatsApp",
  "Airbnb",
  "Booking.com",
  "MakeMyTrip",
  "Goibibo",
  "Agoda",
  "Other OTA",
];
