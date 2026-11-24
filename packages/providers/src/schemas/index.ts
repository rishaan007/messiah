import { z } from "zod";

export const ProviderCredentialsSchema = z.object({
  apiKey: z.string().trim().min(5, "API key cannot be empty"),
  baseUrl: z.string().url("Invalid base URL").optional(),
  organizationId: z.string().trim().optional(),
});
