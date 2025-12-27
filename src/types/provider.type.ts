export interface TYPE_PROVIDER {
  id?: string;
  name?: string;
  streaming?: boolean;
  responseContentPath?: string;
  isCustom?: boolean;
  curl: string;
  // For providers that require special handling (e.g., multi-step APIs like AssemblyAI)
  requiresSpecialHandler?: boolean;
  specialHandler?: string;
}
