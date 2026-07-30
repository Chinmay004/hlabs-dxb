import { prisma } from "@/lib/db";

/**
 * Everything in here is recomputed from scratch after each sync. It is all
 * set-based SQL because it touches every row of a 34k / 10k pair of tables and
 * running it through the ORM row-by-row would dominate the sync time.
 */

/**
 * Every day-bucket below casts through `AT TIME ZONE 'UTC'` rather than a bare
 * `::date`. The columns are timestamptz, so a bare cast would follow whatever
 * TimeZone the connection happens to carry and silently shift records into the
 * neighbouring day. The gateway publishes naive Dubai wall-clock strings which
 * we store as-is against UTC, so pinning the cast to UTC makes a bucket equal
 * the date RERA actually printed.
 */

/**
 * A note on what we deliberately do NOT compute here.
 *
 * It is tempting to reconstruct each card's *original* issue date, so that
 * historical "new brokers per day" excludes annual renewals. Card numbers look
 * chronological, which suggests taking, for each card N, the minimum
 * cardIssueDate over all cards numbered >= N: renewals only push dates later,
 * so that would bound N's first issue and be exact for cards never renewed.
 *
 * The registry does not actually honour that ordering. Card 39426 carries
 * 2001-04-21 while 8515 carries 2010-01-17, and there are more like it. A
 * suffix minimum has no resistance to that - one stale outlier drags every
 * lower-numbered card down with it, which in this dataset collapsed the whole
 * series onto a handful of step dates and left entire months reading zero.
 * The number/date relationship holds in aggregate (median issue date climbs
 * cleanly across number bands) but not per row, and lead lists are read per row.
 *
 * So new-vs-renewal is decided by `Broker.isNewCard`, set at insert time by
 * comparing against a high-water mark we recorded ourselves. That is exact, but
 * only from the second sync onward - which is the honest answer, and fine for a
 * system whose job is catching what opens from here on.
 */

/** Per-office broker counts and momentum, denormalised for fast list queries. */
export async function recomputeRollups() {
  await prisma.$executeRawUnsafe(`
    WITH agg AS (
      SELECT
        "realEstateNumber" AS ren,
        COUNT(*)::int                                              AS broker_count,
        COUNT(*) FILTER (WHERE "isActive")::int                    AS active_count,
        -- Momentum counts first-time cards only, which means it reads 0 for
        -- everyone until the second sync. Preferable to counting renewals as
        -- hiring and scoring every firm as though it were growing.
        COUNT(*) FILTER (
          WHERE "isActive" AND "isNewCard" AND "firstSeenAt" >= NOW() - INTERVAL '30 days'
        )::int                                                     AS new_30d,
        COUNT(*) FILTER (
          WHERE "isActive" AND "isNewCard" AND "firstSeenAt" >= NOW() - INTERVAL '90 days'
        )::int                                                     AS new_90d,
        MIN("cardIssueDate")                                       AS first_card,
        MAX("cardIssueDate")                                       AS last_card
      FROM brokers
      WHERE "realEstateNumber" IS NOT NULL
      GROUP BY "realEstateNumber"
    )
    UPDATE offices o
    SET "brokerCount"       = COALESCE(a.broker_count, 0),
        "activeBrokerCount" = COALESCE(a.active_count, 0),
        "newBrokers30d"     = COALESCE(a.new_30d, 0),
        "newBrokers90d"     = COALESCE(a.new_90d, 0),
        "firstCardIssuedAt" = a.first_card,
        "lastCardIssuedAt"  = a.last_card
    FROM (SELECT "realEstateNumber" FROM offices) all_o
    LEFT JOIN agg a ON a.ren = all_o."realEstateNumber"
    WHERE o."realEstateNumber" = all_o."realEstateNumber"
  `);
}

/**
 * Lead score, 0-100. Weighted for what actually makes a brokerage worth a
 * pitch: it just opened, it is small, and it has no digital presence yet.
 *
 *   Freshness (0-40)  how recently the brokerage was licensed. A firm that
 *                     opened this month is buying tools right now.
 *   Size (0-22)       zero or a handful of brokers means the owner is still
 *                     making the decisions and has nothing entrenched. Large
 *                     firms score low - long sales cycle, existing stack.
 *   Digital gap (0-20) no website, no Instagram, no WhatsApp business number.
 *                     The gap *is* the pitch.
 *   Reachability (0-10) we actually have an email or a mobile to use.
 *   Momentum (0-8)    hiring brokers right now => budget and growth.
 */
export async function recomputeLeadScores() {
  await prisma.$executeRawUnsafe(`
    WITH scored AS (
      SELECT
        "realEstateNumber",
        LEAST(100, GREATEST(0,
          -- freshness
          CASE
            WHEN "issueDate" IS NULL THEN 0
            WHEN "issueDate" >= NOW() - INTERVAL '30 days'  THEN 40
            WHEN "issueDate" >= NOW() - INTERVAL '60 days'  THEN 34
            WHEN "issueDate" >= NOW() - INTERVAL '90 days'  THEN 28
            WHEN "issueDate" >= NOW() - INTERVAL '180 days' THEN 18
            WHEN "issueDate" >= NOW() - INTERVAL '365 days' THEN 10
            WHEN "issueDate" >= NOW() - INTERVAL '730 days' THEN 4
            ELSE 0
          END
          -- size: smaller is better, zero-broker shells are the freshest of all
          + CASE
            WHEN "activeBrokerCount" = 0            THEN 22
            WHEN "activeBrokerCount" BETWEEN 1 AND 3   THEN 20
            WHEN "activeBrokerCount" BETWEEN 4 AND 10  THEN 15
            WHEN "activeBrokerCount" BETWEEN 11 AND 25 THEN 9
            WHEN "activeBrokerCount" BETWEEN 26 AND 60 THEN 4
            ELSE 0
          END
          -- digital gap
          + CASE WHEN "website" IS NULL THEN 9 ELSE 0 END
          + CASE WHEN "instagramUrl" IS NULL THEN 6 ELSE 0 END
          + CASE WHEN "whatsapp" IS NULL THEN 5 ELSE 0 END
          -- reachability
          + CASE WHEN "contactEmail" IS NOT NULL THEN 6 ELSE 0 END
          + CASE WHEN COALESCE("contactMobile", "phone") IS NOT NULL THEN 4 ELSE 0 END
          -- momentum
          + CASE
            WHEN "newBrokers30d" >= 3 THEN 8
            WHEN "newBrokers30d" >= 1 THEN 5
            WHEN "newBrokers90d" >= 1 THEN 2
            ELSE 0
          END
        ))::int AS score
      FROM offices
      WHERE "isActive"
    )
    UPDATE offices o
    SET "leadScore" = s.score,
        "leadTier"  = CASE
          WHEN s.score >= 80 THEN 'A+'
          WHEN s.score >= 68 THEN 'A'
          WHEN s.score >= 55 THEN 'B'
          WHEN s.score >= 40 THEN 'C'
          ELSE 'D'
        END
    FROM scored s
    WHERE o."realEstateNumber" = s."realEstateNumber"
  `);

  // Inactive brokerages are not leads.
  await prisma.$executeRawUnsafe(`
    UPDATE offices SET "leadScore" = 0, "leadTier" = 'D' WHERE NOT "isActive"
  `);

  await recomputeBrokerLeadScores();
}

/**
 * Broker lead score, 0-100. A broker is worth calling for different reasons
 * than a firm: what matters is that the licence is genuinely new (they are
 * setting themselves up right now), that we can actually reach them, and that
 * the firm behind them is small enough that the broker buys their own tools.
 *
 *   First licence (0-45)  a brand-new card is the whole premise. Renewals score
 *                         zero here — they have been in the market for years.
 *   Recency (0-20)        how recently we discovered them.
 *   Firm size (0-15)      at a small firm the broker buys for themselves; at a
 *                         200-agent shop the firm buys centrally.
 *   Reachability (0-20)   a mobile is worth more than an email for this segment.
 */
export async function recomputeBrokerLeadScores() {
  await prisma.$executeRawUnsafe(`
    WITH scored AS (
      SELECT
        b."cardNumber",
        LEAST(100, GREATEST(0,
          CASE WHEN b."isNewCard" THEN 45 ELSE 0 END
          + CASE
              WHEN b."firstSeenAt" >= NOW() - INTERVAL '7 days'  THEN 20
              WHEN b."firstSeenAt" >= NOW() - INTERVAL '30 days' THEN 14
              WHEN b."firstSeenAt" >= NOW() - INTERVAL '90 days' THEN 7
              ELSE 0
            END
          + CASE
              WHEN o."activeBrokerCount" IS NULL              THEN 0
              WHEN o."activeBrokerCount" BETWEEN 1 AND 5      THEN 15
              WHEN o."activeBrokerCount" BETWEEN 6 AND 20     THEN 10
              WHEN o."activeBrokerCount" BETWEEN 21 AND 60    THEN 5
              ELSE 0
            END
          + CASE WHEN b."mobile" IS NOT NULL THEN 12 ELSE 0 END
          + CASE WHEN b."email"  IS NOT NULL THEN 8  ELSE 0 END
        ))::int AS score
      FROM brokers b
      LEFT JOIN offices o ON o."realEstateNumber" = b."realEstateNumber"
      WHERE b."isActive"
    )
    UPDATE brokers b
    SET "leadScore" = s.score,
        "leadTier"  = CASE
          WHEN s.score >= 80 THEN 'A+'
          WHEN s.score >= 68 THEN 'A'
          WHEN s.score >= 55 THEN 'B'
          WHEN s.score >= 40 THEN 'C'
          ELSE 'D'
        END
    FROM scored s
    WHERE b."cardNumber" = s."cardNumber"
      AND (b."leadScore" IS DISTINCT FROM s.score)
  `);

  await prisma.$executeRawUnsafe(`
    UPDATE brokers SET "leadScore" = 0, "leadTier" = 'D'
    WHERE NOT "isActive" AND "leadScore" <> 0
  `);
}

/**
 * Rebuild the per-day fact table across the full span the registry covers, so
 * every day in range has a row (including zero days - a gap in a chart is a
 * different statement from a zero).
 */
export async function recomputeDailyStats() {
  await prisma.$executeRawUnsafe(`
    WITH bounds AS (
      SELECT
        LEAST(
          COALESCE((SELECT (MIN("issueDate") AT TIME ZONE 'UTC')::date FROM offices), CURRENT_DATE),
          COALESCE((SELECT (MIN("cardIssueDate") AT TIME ZONE 'UTC')::date FROM brokers), CURRENT_DATE)
        ) AS lo,
        GREATEST(
          COALESCE((SELECT (MAX("expiryDate") AT TIME ZONE 'UTC')::date FROM offices), CURRENT_DATE),
          COALESCE((SELECT (MAX("cardExpiryDate") AT TIME ZONE 'UTC')::date FROM brokers), CURRENT_DATE),
          CURRENT_DATE
        ) AS hi
    ),
    days AS (
      SELECT generate_series(lo, hi, INTERVAL '1 day')::date AS d FROM bounds
    ),
    off_issued AS (
      SELECT ("issueDate" AT TIME ZONE 'UTC')::date AS d, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE "activeBrokerCount" = 0)::int AS n_empty
      FROM offices WHERE "issueDate" IS NOT NULL GROUP BY 1
    ),
    off_found AS (
      SELECT ("firstSeenAt" AT TIME ZONE 'UTC')::date AS d, COUNT(*)::int AS n
      FROM offices GROUP BY 1
    ),
    off_exp AS (
      SELECT ("expiryDate" AT TIME ZONE 'UTC')::date AS d, COUNT(*)::int AS n
      FROM offices WHERE "expiryDate" IS NOT NULL AND "isActive" GROUP BY 1
    ),
    brk_issued AS (
      SELECT ("cardIssueDate" AT TIME ZONE 'UTC')::date AS d,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE "isNewCard")::int AS n_new
      FROM brokers WHERE "cardIssueDate" IS NOT NULL GROUP BY 1
    ),
    brk_found AS (
      SELECT ("firstSeenAt" AT TIME ZONE 'UTC')::date AS d, COUNT(*)::int AS n
      FROM brokers GROUP BY 1
    ),
    brk_exp AS (
      SELECT ("cardExpiryDate" AT TIME ZONE 'UTC')::date AS d, COUNT(*)::int AS n
      FROM brokers WHERE "cardExpiryDate" IS NOT NULL AND "isActive" GROUP BY 1
    )
    INSERT INTO daily_stats (
      "date", "officesIssued", "officesDiscovered", "officesExpiring",
      "officesIssuedNoBrokers",
      "brokerCardsIssued", "brokersNew",
      "brokersDiscovered", "brokerCardsExpiring",
      "updatedAt"
    )
    SELECT
      days.d,
      COALESCE(oi.n, 0), COALESCE(ofd.n, 0), COALESCE(oe.n, 0),
      COALESCE(oi.n_empty, 0),
      COALESCE(bi.n, 0), COALESCE(bi.n_new, 0),
      COALESCE(bfd.n, 0), COALESCE(be.n, 0),
      NOW()
    FROM days
    LEFT JOIN off_issued oi  ON oi.d  = days.d
    LEFT JOIN off_found  ofd ON ofd.d = days.d
    LEFT JOIN off_exp    oe  ON oe.d  = days.d
    LEFT JOIN brk_issued bi  ON bi.d  = days.d
    LEFT JOIN brk_found  bfd ON bfd.d = days.d
    LEFT JOIN brk_exp    be  ON be.d  = days.d
    ON CONFLICT ("date") DO UPDATE SET
      "officesIssued"          = EXCLUDED."officesIssued",
      "officesDiscovered"      = EXCLUDED."officesDiscovered",
      "officesExpiring"        = EXCLUDED."officesExpiring",
      "officesIssuedNoBrokers" = EXCLUDED."officesIssuedNoBrokers",
      "brokerCardsIssued"      = EXCLUDED."brokerCardsIssued",
      "brokersNew"             = EXCLUDED."brokersNew",
      "brokersDiscovered"      = EXCLUDED."brokersDiscovered",
      "brokerCardsExpiring"    = EXCLUDED."brokerCardsExpiring",
      "updatedAt"              = NOW()
  `);
}
