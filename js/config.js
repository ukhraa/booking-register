// Paste your Supabase project's details here (Dashboard → Project Settings → API).
// The anon key is meant to be public: the security rules in supabase/schema.sql
// are what protect your data, so only signed-in staff can see bookings.

export const SUPABASE_URL = "https://YOUR-PROJECT-ID.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";

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
