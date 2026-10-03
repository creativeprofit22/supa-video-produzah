/**
 * Agent graphics description: the compact, agent-writable form of on-screen graphics (see CONTEXT.md).
 * An agent or rule writes only text, timing and an optional style recipe; the graphics compiler
 * turns it into full graphics clips inside a graphics proposal. See
 * docs/adr/0005-agent-graphics-proposals.md.
 */
import { z } from "zod";

import { renderCaptionFontKeySchema } from "./render-fonts.js";

export const AGENT_GRAPHICS_DESCRIPTION_VERSION = 1;
export const AGENT_GRAPHICS_MAX_ITEMS = 64;
export const AGENT_GRAPHICS_MAX_TEXT_LENGTH = 120;

/** Entrance presets an agent may name; mirrors `MOTION_PRESET_NAMES` in @supa-video/project. */
export const agentGraphicsPresetSchema = z.enum([
  "slam",
  "pop",
  "tiltIn",
  "cursorDrag",
  "rockSlide",
]);
export type AgentGraphicsPreset = z.infer<typeof agentGraphicsPresetSchema>;

export const agentGraphicsCardRoleSchema = z.enum(["title", "lowerThird", "endCard"]);
export type AgentGraphicsCardRole = z.infer<typeof agentGraphicsCardRoleSchema>;

export const agentGraphicsRevealSchema = z.enum(["word", "letter"]);
export type AgentGraphicsReveal = z.infer<typeof agentGraphicsRevealSchema>;

export const agentGraphicsColourSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/u, "Colour must be #RRGGBB");

const microseconds = z.number().int().safe().nonnegative();
const positiveMicroseconds = z.number().int().safe().positive();
// Length is checked by the compiler so an over-long text reports `text_too_long`, not a parse error.
const text = z.string().trim().min(1).max(4096);
const itemId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, "Item id must be lowercase letters, digits and dashes");

const styleOverrides = {
  fontKey: renderCaptionFontKeySchema.optional(),
  colour: agentGraphicsColourSchema.optional(),
};

export const agentGraphicsCardItemSchema = z
  .object({
    kind: z.literal("card"),
    id: itemId,
    role: agentGraphicsCardRoleSchema,
    text,
    atUs: microseconds,
    durationUs: positiveMicroseconds.optional(),
    preset: agentGraphicsPresetSchema.optional(),
    ...styleOverrides,
  })
  .strict();

export const agentGraphicsCaptionItemSchema = z
  .object({
    kind: z.literal("caption"),
    id: itemId,
    text,
    atUs: microseconds,
    durationUs: positiveMicroseconds.optional(),
    reveal: agentGraphicsRevealSchema.optional(),
    ...styleOverrides,
  })
  .strict();

export const agentGraphicsItemSchema = z.discriminatedUnion("kind", [
  agentGraphicsCardItemSchema,
  agentGraphicsCaptionItemSchema,
]);
export type AgentGraphicsItem = z.infer<typeof agentGraphicsItemSchema>;

export const agentGraphicsDescriptionSchema = z
  .object({
    schemaVersion: z.literal(AGENT_GRAPHICS_DESCRIPTION_VERSION),
    recipeId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
      .optional(),
    items: z.array(agentGraphicsItemSchema).min(1).max(AGENT_GRAPHICS_MAX_ITEMS),
  })
  .strict()
  .superRefine((description, context) => {
    const seen = new Set<string>();
    for (const [index, item] of description.items.entries()) {
      if (seen.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Item ids must be unique",
        });
      }
      seen.add(item.id);
    }
  });
export type AgentGraphicsDescription = z.infer<typeof agentGraphicsDescriptionSchema>;
