import { z } from "zod";

export const extractionSchema = z.object({
  supplierName: z.string().nullable(),
  productName: z.string().nullable(),
  countryOfOrigin: z.string().nullable(),
  material: z.string().nullable(),
  certificates: z.array(z.string()),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

export const extractionRequestSchema = z.object({
  document: z.string({
    message: "document is required and must be a string",
  }),
});

export type ExtractionRequest = z.infer<typeof extractionRequestSchema>;
