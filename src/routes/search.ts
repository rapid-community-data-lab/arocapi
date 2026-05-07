import type { MultiBucketAggregateBaseFiltersBucket } from '@opensearch-project/opensearch/api/_types/_common.aggregations.js';
import type { Search_Request } from '@opensearch-project/opensearch/api/index.js';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { baseEntityTransformer, resolveEntityReferences } from '../transformers/default.js';
import type { AccessTransformer, EntityTransformer } from '../types/transformers.js';
import { createInternalError, createInvalidRequestError } from '../utils/errors.js';
import { OpensearchQueryBuilder, type QueryBuilderOptions } from '../utils/queryBuilder.js';

const boundingBoxSchema = z.object({
  topRight: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
  bottomLeft: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
});

const searchParamsSchema = z.object({
  searchType: z.enum(['basic', 'advanced']).default('basic'),
  query: z.string(),
  filters: z.record(z.string(), z.array(z.string())).optional(),
  boundingBox: boundingBoxSchema.optional(),
  geohashPrecision: z.number().int().min(1).max(12).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
  sort: z.enum(['id', 'name', 'createdAt', 'updatedAt', 'relevance']).default('relevance'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

type SearchRouteOptions = {
  accessTransformer: AccessTransformer;
  entityTransformers?: EntityTransformer[];
  queryBuilderClass?: typeof OpensearchQueryBuilder;
  queryBuilderOptions?: QueryBuilderOptions;
};

const search: FastifyPluginAsync<SearchRouteOptions> = async (fastify, opts) => {
  const {
    accessTransformer,
    entityTransformers = [],
    queryBuilderClass = OpensearchQueryBuilder,
    queryBuilderOptions,
  } = opts;
  const queryBuilder = new queryBuilderClass(queryBuilderOptions);
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/search',
    {
      schema: {
        body: searchParamsSchema,
      },
    },
    async (request, reply) => {
      const { searchType, query, filters, boundingBox, geohashPrecision, limit, offset, sort, order } = request.body;

      try {
        const opensearchQuery: Search_Request = {
          index: 'entities',
          body: {
            query: queryBuilder.buildQuery(searchType, query, filters, boundingBox),
            aggs: queryBuilder.buildAggregations(geohashPrecision, boundingBox),
            highlight: {
              fields: {
                name: {},
                description: {},
              },
            },
            sort: queryBuilder.buildSort(sort, order),
            from: offset,
            size: limit,
          },
        };
        fastify.log.debug(opensearchQuery);
        const response = await fastify.opensearch.search(opensearchQuery);

        if (!response.body?.hits?.hits) {
          throw new Error('Invalid search response: missing hits data');
        }

        const entityIds = response.body.hits.hits.map((hit) => hit._source?.id as string | undefined).filter(Boolean);

        const dbEntities = await fastify.prisma.entity.findMany({
          where: {
            id: {
              in: entityIds,
            },
          },
          include: { file: { select: { id: true } } },
        });

        const entityMap = new Map(dbEntities.map((entity) => [entity.id, entity]));

        // Resolve memberOf and rootCollection references
        const refMap = await resolveEntityReferences(dbEntities, fastify.prisma);

        const entities = await Promise.all(
          response.body.hits.hits.map(async (hit) => {
            if (!hit._source?.id) {
              throw new Error('Missing id in search hit');
            }

            const dbEntity = entityMap.get(hit._source.id);
            if (!dbEntity) {
              const src = hit._source as Record<string, unknown>;
              const pickStr = (v: unknown): string =>
                Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v);
              return {
                id: hit._source.id,
                name: pickStr(src.name) || hit._source.id,
                description: pickStr(src.description),
                entityType: pickStr(src.entityType),
                memberOf: null,
                rootCollection: null,
                metadataLicenseId: pickStr(src.metadataLicenseId),
                contentLicenseId: pickStr(src.contentLicenseId),
                access: { metadata: true, content: false },
                counts: { collections: 0, objects: 0, files: 0 },
                searchExtra: { score: hit._score, highlight: hit.highlight },
              };
            }

            const base = baseEntityTransformer(dbEntity);
            const standardEntity = {
              ...base,
              memberOf: base.memberOf ? (refMap.get(base.memberOf) ?? null) : null,
              rootCollection: base.rootCollection ? (refMap.get(base.rootCollection) ?? null) : null,
            };
            const authorisedEntity = await accessTransformer(standardEntity, {
              request,
              fastify,
            });

            let result = authorisedEntity;
            for (const transformer of entityTransformers) {
              result = await transformer(result, {
                request,
                fastify,
              });
            }

            // Add search-specific metadata
            return {
              ...(result as Record<string, unknown>),
              searchExtra: {
                score: hit._score,
                highlight: hit.highlight,
              },
            };
          }),
        ).then((results) => results.filter(Boolean));

        const facets: Record<string, Array<{ name: string; count: number }>> = {};
        if (response.body.aggregations) {
          Object.keys(response.body.aggregations).forEach((key) => {
            if (key !== 'geohash_grid') {
              const agg = response.body.aggregations?.[key] as MultiBucketAggregateBaseFiltersBucket;
              if (agg?.buckets && Array.isArray(agg.buckets)) {
                facets[key] = agg.buckets.map((bucket) => ({
                  name: bucket.key,
                  count: bucket.doc_count,
                }));
              }
            }
          });
        }

        let geohashGrid: Record<string, number> | undefined;
        if (response.body.aggregations?.geohash_grid) {
          const geohashAgg = response.body.aggregations.geohash_grid as MultiBucketAggregateBaseFiltersBucket;
          if (geohashAgg?.buckets && Array.isArray(geohashAgg.buckets)) {
            geohashAgg.buckets.forEach((bucket) => {
              geohashGrid ||= {};
              geohashGrid[bucket.key] = bucket.doc_count;
            });
          }
        }

        /* v8 ignore next 3 -- Not sure how to force opensearch to hit the other path -- @preserve */
        const total =
          typeof response.body.hits.total === 'number'
            ? response.body.hits.total
            : response.body.hits.total?.value || 0;

        const result = {
          total,
          searchTime: response.body.took,
          entities,
          facets: Object.keys(facets).length > 0 ? facets : undefined,
          geohashGrid,
        };

        return result;
      } catch (error) {
        const err = error as Error;

        // OpenSearch returns 400 for malformed queries (e.g. invalid query_string syntax)
        if ('statusCode' in err && (err as { statusCode: number }).statusCode === 400) {
          fastify.log.warn(`Invalid search query: ${err.message}`);

          return reply.code(422).send(createInvalidRequestError(err.message));
        }

        fastify.log.error(`Search error: ${err.message}`);

        return reply.code(500).send(createInternalError('Search failed'));
      }
    },
  );
};

export default search;
