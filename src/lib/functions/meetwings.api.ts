import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "../storage";
import { STORAGE_KEYS } from "@/config";

// Helper function to check if Meetwings API should be used
export async function shouldUseMeetwingsAPI(): Promise<boolean> {
  try {
    // Check if Meetwings API is enabled in localStorage
    const meetwingsApiEnabled =
      safeLocalStorage.getItem(STORAGE_KEYS.MEETWINGS_API_ENABLED) === "true";
    if (!meetwingsApiEnabled) return false;

    // Check if license is available
    const hasLicense = await invoke<boolean>("check_license_status");
    return hasLicense;
  } catch (error) {
    console.warn("Failed to check Meetwings API availability:", error);
    return false;
  }
}
