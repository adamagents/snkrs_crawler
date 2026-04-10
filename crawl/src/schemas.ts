import { z } from "zod";

export const nextDataSchema = z.object({
  props: z.object({
    pageProps: z.object({
      initialState: z.string().min(2),
    }),
  }),
});

export const threadsDataSchema = z.object({
  product: z.object({
    threads: z.object({
      data: z.object({
        ids: z.array(z.string()),
        items: z.record(z.string(), z.unknown()),
      }),
    }),
  }),
});

export const normalizedLaunchItemSchema = z.object({
  id: z.string(),
  product_id: z.string(),
  slug: z.string().nullable(),
  name: z.string().nullable(),
  color: z.string().nullable(),
  price: z.object({
    currency: z.string().nullable(),
    current: z.number().nullable(),
    full: z.number().nullable(),
    msrp: z.number().nullable(),
  }),
  availability_date_pacific: z.string().nullable(),
  availability: z.object({
    launch_status: z.string().nullable(),
    available_now: z.boolean(),
    in_stock_skus: z.number().int().nonnegative(),
    total_skus: z.number().int().nonnegative(),
  }),
  feed_url: z.string().url(),
  style_color: z.string().nullable(),
});
