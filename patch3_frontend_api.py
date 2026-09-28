FILE = "src/api.ts"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

old_interface = '''  report_url?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}'''

new_interface = '''  report_url?: string | null;
  notes?: string | null;
  late_flag?: boolean;
  late_eta_minutes?: number | null;
  created_at: string;
  updated_at: string;
}'''

if old_interface not in content:
    print("ERROR: Could not find LabBooking interface tail. No changes made.")
    raise SystemExit(1)
content = content.replace(old_interface, new_interface, 1)

old_fn = '''  updateStatus: (id: string, data: { status: LabBooking["status"]; reportUrl?: string; notes?: string }) =>
    patch<LabBooking>(`/labs/bookings/${id}/status`, data),'''

new_fn = '''  updateStatus: (id: string, data: { status: LabBooking["status"]; reportUrl?: string; notes?: string }) =>
    patch<LabBooking>(`/labs/bookings/${id}/status`, data),
  markLate: (id: string, etaMinutes: number) =>
    post<{ success: boolean; etaMinutes: number }>(`/labs/bookings/${id}/mark-late`, { etaMinutes }),'''

if old_fn not in content:
    print("ERROR: Could not find updateStatus function. No changes made.")
    raise SystemExit(1)
content = content.replace(old_fn, new_fn, 1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)
print("Success: markLate added to api.ts")
