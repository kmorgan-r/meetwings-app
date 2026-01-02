# API Key Security - Secure Storage Implementation

## Overview

This document describes how Meetwings securely stores API keys and other sensitive credentials using Tauri's encrypted store plugin instead of browser localStorage.

## Security Issue (FIXED)

**Previous Vulnerability:** API keys were stored in browser localStorage, which is vulnerable to:
- XSS (Cross-Site Scripting) attacks
- Malicious browser extensions
- Any JavaScript code running in the page context
- Local file access if the user's system is compromised

**Current Solution:** API keys are now stored using Tauri's secure store plugin, which provides:
- Encryption at rest using OS-level security features
- Protection from browser-based attacks (XSS, malicious extensions)
- Secure storage location in the app data directory
- Automatic migration from localStorage to secure storage

## Implementation Details

### Secure Storage API

Location: `src/lib/secure-storage.ts`

The secure storage module provides the following functions:

```typescript
// Store a sensitive value (encrypted)
await secureSet(key: string, value: string): Promise<void>

// Retrieve a securely stored value (decrypted)
await secureGet(key: string): Promise<string | null>

// Remove a securely stored value
await secureDelete(key: string): Promise<void>

// Check if a key exists
await secureHas(key: string): Promise<boolean>

// Clear all secure storage (use with caution!)
await secureClear(): Promise<void>

// Migrate data from localStorage to secure storage
await migrateFromLocalStorage(key: string, deleteFromLocalStorage: boolean): Promise<void>
```

### Storage Backend

- **File**: `.secure-settings.dat` (stored in app data directory)
- **Encryption**: Provided by Tauri's plugin-store
- **Format**: Binary encrypted format
- **Permissions**: OS-level file permissions (user-only access)

### Currently Secured API Keys

1. **AssemblyAI API Key** (`STORAGE_KEYS.ASSEMBLYAI_API_KEY`)
   - Used for speaker diarization feature
   - Required for AssemblyAI STT provider
   - Automatically migrated from localStorage on first load
   - Stored location: `DiarizationSettings.tsx`, `Audio.tsx`

## Migration Process

When the application loads, it automatically:

1. Checks if the API key exists in localStorage
2. If found, migrates it to secure storage
3. Deletes the key from localStorage (one-time migration)
4. All future reads/writes use secure storage only

**Code Example:**
```typescript
// Automatic migration on component mount
useEffect(() => {
  const loadApiKey = async () => {
    try {
      // One-time migration from localStorage
      await migrateFromLocalStorage(STORAGE_KEYS.ASSEMBLYAI_API_KEY, true);

      // Load from secure storage
      const key = await secureGet(STORAGE_KEYS.ASSEMBLYAI_API_KEY);
      setAssemblyAIKey(key || "");
    } catch (error) {
      console.error("Failed to load API key from secure storage:", error);
      toast.error("Failed to load API key", {
        description: "Secure storage error. Please restart the application.",
      });
      setAssemblyAIKey("");
    }
  };

  loadApiKey();
}, []);
```

## Error Handling

### No localStorage Fallback

**Important:** The implementation does NOT fall back to localStorage if secure storage fails. This is intentional for security reasons.

**Behavior when secure storage fails:**
- Error is logged to console
- User-visible toast notification is shown
- Empty string is set as the API key value
- User must restart the application or re-enter the key

**Rationale:** Falling back to localStorage would defeat the security purpose. If secure storage fails, it indicates a system-level issue that should be addressed rather than silently degraded.

### User-Facing Error Messages

**Load Failure:**
```
Failed to load API key
Secure storage error. Please restart the application.
```

**Save Failure:**
```
Failed to save API key
Secure storage error. Your API key was not saved. Please try again or restart the application.
```

## Security Best Practices

### For Developers

1. **Always use secure storage for API keys:**
   ```typescript
   import { secureSet, secureGet } from "@/lib/secure-storage";

   // DO THIS
   await secureSet("my_api_key", apiKeyValue);

   // NOT THIS
   localStorage.setItem("my_api_key", apiKeyValue); // VULNERABLE!
   ```

2. **Never log API keys:**
   ```typescript
   // DO THIS
   console.error("Failed to save API key to secure storage");

   // NOT THIS
   console.log("Saving API key:", apiKey); // SECURITY RISK!
   ```

3. **Sanitize error messages:**
   ```typescript
   catch (error) {
     // DO NOT include API keys in error messages
     console.error("API request failed:", error.message);
     // NOT: console.error("API request failed with key:", apiKey);
   }
   ```

4. **Use password input fields:**
   ```tsx
   <Input
     type="password"  // Hides the value
     value={apiKey}
     onChange={(e) => setApiKey(e.target.value)}
   />
   ```

### For Users

1. **Keep your system secure:**
   - Use OS-level encryption (FileVault, BitLocker)
   - Keep your system updated
   - Use strong user account passwords

2. **If you see API key errors:**
   - Try restarting the application
   - Check OS permissions for the app data directory
   - Re-enter the API key if needed

3. **Protect your API keys:**
   - Never share screenshots showing API keys
   - Revoke and regenerate keys if compromised
   - Monitor API usage for unauthorized activity

## Custom Provider Configurations

### API Keys in CURL Templates

Custom AI and STT providers allow users to configure API endpoints using CURL templates. These templates may contain API keys in two ways:

1. **Hardcoded (Quick Setup):**
   ```bash
   curl --location 'https://api.example.com/v1/chat' \
   --header 'Authorization: Bearer sk-abc123...'
   ```

2. **Variables (Recommended):**
   ```bash
   curl --location 'https://api.example.com/v1/chat' \
   --header 'Authorization: Bearer {{API_KEY}}'
   ```

**Security Note:** Custom provider configurations (including CURL templates) are currently stored in localStorage. This is acceptable because:
- Users choose whether to hardcode keys or use variables
- The UI explicitly documents this as "Quick Setup" vs proper variable configuration
- Custom providers are an advanced feature for users who understand the tradeoffs

**Future Enhancement:** Consider adding an option to extract `{{API_KEY}}` variables from custom providers and store them in secure storage separately.

## Testing Secure Storage

### Manual Testing

1. **Test Migration:**
   - Manually set an API key in localStorage using browser DevTools
   - Restart the application
   - Verify the key is loaded correctly
   - Verify the key is removed from localStorage

2. **Test Secure Storage:**
   - Enter an API key in the Speakers settings
   - Restart the application
   - Verify the key persists across restarts
   - Check that localStorage does NOT contain the key

3. **Test Error Handling:**
   - Simulate secure storage failure (requires modifying code temporarily)
   - Verify toast notification appears
   - Verify app doesn't crash

### Automated Testing

Currently, there are no automated tests for secure storage. Future tests should verify:
- Migration from localStorage works correctly
- Secure get/set operations work
- Error handling behaves correctly
- No API keys leak to localStorage

## Platform-Specific Details

### Windows
- Storage location: `%APPDATA%\com.meetwings.app\.secure-settings.dat`
- Encryption: Windows DPAPI

### macOS
- Storage location: `~/Library/Application Support/com.meetwings.app/.secure-settings.dat`
- Encryption: macOS Keychain integration

### Linux
- Storage location: `~/.local/share/com.meetwings.app/.secure-settings.dat`
- Encryption: System-dependent (typically gnome-keyring or similar)

## Compliance and Auditing

### OWASP Top 10

This implementation addresses:
- **A02:2021 – Cryptographic Failures:** API keys are encrypted at rest
- **A03:2021 – Injection:** No SQL/command injection risks (file-based storage)
- **A05:2021 – Security Misconfiguration:** Secure defaults, no fallback to insecure storage

### Security Checklist

- [x] API keys stored in encrypted format
- [x] No localStorage fallback for sensitive data
- [x] Automatic migration from insecure storage
- [x] User-visible error messages for storage failures
- [x] Password-type input fields for API keys
- [x] No API keys in logs or error messages
- [x] OS-level file permissions protect storage file
- [ ] Automated security tests (future work)
- [ ] Third-party security audit (future work)

## References

- [Tauri Plugin Store Documentation](https://v2.tauri.app/plugin/store/)
- [OWASP Secure Coding Practices](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/)
- [NIST Special Publication 800-57](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final) - Key Management

## Changelog

### 2025-01-02
- Initial implementation of secure storage for AssemblyAI API key
- Removed localStorage fallbacks from `DiarizationSettings.tsx` and `Audio.tsx`
- Added user-visible error handling with toast notifications
- Created comprehensive documentation

---

**Security Contact:** For security concerns, please report them through [GitHub Security Advisories](https://github.com/kmorgan-r/meetwings-app/security/advisories/new).
