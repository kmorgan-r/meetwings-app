/**
 * usePricing Hook
 *
 * Provides pricing information for AI and STT models with estimation support.
 * Centralizes pricing logic that was previously scattered in components.
 */

import { useMemo } from "react";
import {
  getModelPricing,
  getSTTModelPricing,
  formatCost,
  getPricingConfig,
  getSTTPricingConfig,
} from "@/lib/storage/pricing.storage";

export interface PricingInfo {
  /** Formatted pricing text for display */
  text: string;
  /** Whether this is an estimated price (using fallback/wildcard) */
  isEstimate: boolean;
  /** Raw input cost per 1K tokens (AI only) */
  inputPer1k?: number;
  /** Raw output cost per 1K tokens (AI only) */
  outputPer1k?: number;
  /** Raw cost per minute (STT only) */
  perMinute?: number;
}

export interface EstimatedCost {
  /** Formatted estimated cost text */
  text: string;
  /** Whether this is an estimated price */
  isEstimate: boolean;
  /** Raw estimated cost value */
  rawCost: number;
}

/**
 * Check if pricing for a model is using fallback/estimated values.
 * Returns true if using wildcard (*) pricing instead of exact model pricing.
 */
function isUsingFallbackPricing(
  providerId: string,
  modelId: string,
  type: "ai" | "stt"
): boolean {
  if (type === "ai") {
    const config = getPricingConfig();
    const providerPricing = config[providerId];
    if (!providerPricing) return true; // Using provider wildcard
    if (providerPricing[modelId]) return false; // Exact match found
    // Check if any pattern matches
    for (const pattern of Object.keys(providerPricing)) {
      if (
        pattern !== "*" &&
        modelId.toLowerCase().includes(pattern.toLowerCase())
      ) {
        return false; // Pattern match found
      }
    }
    return true; // Using wildcard
  } else {
    const config = getSTTPricingConfig();
    const providerPricing = config[providerId];
    if (!providerPricing) return true;
    if (providerPricing[modelId]) return false;
    for (const pattern of Object.keys(providerPricing)) {
      if (
        pattern !== "*" &&
        modelId.toLowerCase().includes(pattern.toLowerCase())
      ) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Format AI pricing for display
 */
export function formatAIPricing(
  providerId: string,
  modelId: string
): PricingInfo {
  const pricing = getModelPricing(providerId, modelId);
  const isEstimate = isUsingFallbackPricing(providerId, modelId, "ai");

  if (pricing.inputPer1k === 0 && pricing.outputPer1k === 0) {
    return { text: "Free", isEstimate: false, inputPer1k: 0, outputPer1k: 0 };
  }

  return {
    text: `$${pricing.inputPer1k}/$${pricing.outputPer1k} per 1K`,
    isEstimate,
    inputPer1k: pricing.inputPer1k,
    outputPer1k: pricing.outputPer1k,
  };
}

/**
 * Format STT pricing for display
 */
export function formatSTTPricing(
  providerId: string,
  modelId: string
): PricingInfo {
  const pricing = getSTTModelPricing(providerId, modelId);
  const isEstimate = isUsingFallbackPricing(providerId, modelId, "stt");

  if (pricing.perMinute === 0) {
    return { text: "Free", isEstimate: false, perMinute: 0 };
  }

  const text =
    pricing.perMinute < 0.001
      ? `$${pricing.perMinute.toFixed(5)}/min`
      : `$${pricing.perMinute.toFixed(4)}/min`;

  return { text, isEstimate, perMinute: pricing.perMinute };
}

/**
 * Calculate estimated cost for typical usage
 */
export function getEstimatedCost(
  providerId: string,
  modelId: string,
  type: "ai" | "stt"
): EstimatedCost {
  const isEstimate = isUsingFallbackPricing(providerId, modelId, type);

  if (type === "ai") {
    const pricing = getModelPricing(providerId, modelId);
    if (pricing.inputPer1k === 0 && pricing.outputPer1k === 0) {
      return { text: "Free (local model)", isEstimate: false, rawCost: 0 };
    }
    // Estimate based on 500 input + 500 output tokens (typical request)
    const inputCost = (500 / 1000) * pricing.inputPer1k;
    const outputCost = (500 / 1000) * pricing.outputPer1k;
    const totalCost = inputCost + outputCost;
    return {
      text: `~${formatCost(totalCost)} per typical request (500 in/out tokens)`,
      isEstimate,
      rawCost: totalCost,
    };
  } else {
    const pricing = getSTTModelPricing(providerId, modelId);
    if (pricing.perMinute === 0) {
      return { text: "Free (local model)", isEstimate: false, rawCost: 0 };
    }
    return {
      text: `~${formatCost(pricing.perMinute)} per minute of audio`,
      isEstimate,
      rawCost: pricing.perMinute,
    };
  }
}

interface UsePricingOptions {
  providerId: string;
  modelId: string;
  type: "ai" | "stt";
}

interface UsePricingReturn {
  /** Pricing info for the model */
  pricing: PricingInfo;
  /** Estimated cost for typical usage */
  estimatedCost: EstimatedCost | null;
}

/**
 * Hook for getting pricing information for a model.
 *
 * Usage:
 * ```tsx
 * const { pricing, estimatedCost } = usePricing({
 *   providerId: "openai",
 *   modelId: "gpt-4o",
 *   type: "ai",
 * });
 *
 * return (
 *   <div>
 *     <span>{pricing.text}</span>
 *     {pricing.isEstimate && <span>(estimated)</span>}
 *   </div>
 * );
 * ```
 */
export function usePricing({
  providerId,
  modelId,
  type,
}: UsePricingOptions): UsePricingReturn {
  const pricing = useMemo(() => {
    if (!modelId) {
      return { text: "—", isEstimate: false };
    }
    return type === "ai"
      ? formatAIPricing(providerId, modelId)
      : formatSTTPricing(providerId, modelId);
  }, [providerId, modelId, type]);

  const estimatedCost = useMemo(() => {
    if (!modelId) return null;
    return getEstimatedCost(providerId, modelId, type);
  }, [providerId, modelId, type]);

  return { pricing, estimatedCost };
}
