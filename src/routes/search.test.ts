import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fastify, fastifyAfter, fastifyBefore, opensearch, prisma } from '../test/helpers/fastify.js';
import { AllPublicAccessTransformer } from '../transformers/default.js';
import type { StandardErrorResponse } from '../utils/errors.js';
import searchRoute from './search.js';

describe('Search Route', () => {
  beforeEach(async () => {
    await fastifyBefore();
    await fastify.register(searchRoute, { prisma, opensearch, accessTransformer: AllPublicAccessTransformer });
  });

  afterEach(async () => {
    await fastifyAfter();
  });

  describe('POST /search', () => {
    it('should perform basic search successfully', async () => {
      const mockEntities = [
        {
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'A test entity',
          entityType: 'http://pcdm.org/models#Collection',
          memberOf: null,
          rootCollection: null,
          metadataLicenseId: null,
          contentLicenseId: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
        {
          id: 'http://example.com/entity/2',
          name: 'Test Entity 2',
          description: 'Another test entity',
          entityType: 'http://pcdm.org/models#Object',
          memberOf: null,
          rootCollection: null,
          metadataLicenseId: null,
          contentLicenseId: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ];

      const mockSearchResponse = {
        body: {
          took: 10,
          hits: {
            total: { value: 2 },
            hits: [
              {
                _score: 1.5,
                _source: {
                  id: 'http://example.com/entity/1',
                },
                highlight: {
                  name: ['<em>Test</em> Entity 1'],
                },
              },
              {
                _score: 1.2,
                _source: {
                  id: 'http://example.com/entity/2',
                },
                highlight: {
                  description: ['Another <em>test</em> entity'],
                },
              },
            ],
          },
          aggregations: {
            entityType: {
              buckets: [
                { key: 'http://pcdm.org/models#Collection', doc_count: 1 },
                { key: 'http://pcdm.org/models#Object', doc_count: 1 },
              ],
            },
          },
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      // @ts-expect-error TS is looking at the wrong function signature
      prisma.entity.findMany.mockResolvedValue(mockEntities);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          searchType: 'basic',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toMatchSnapshot();

      // Verify database was queried with correct ids
      expect(prisma.entity.findMany).toHaveBeenCalledWith({
        where: {
          id: {
            in: ['http://example.com/entity/1', 'http://example.com/entity/2'],
          },
        },
        include: { file: { select: { id: true } } },
      });

      expect(opensearch.search).toHaveBeenCalledWith({
        index: 'entities',
        body: {
          query: {
            bool: {
              must: [
                {
                  multi_match: {
                    query: 'test',
                    fields: ['name^2', 'description'],
                    type: 'best_fields',
                    fuzziness: 'AUTO',
                    zero_terms_query: 'all',
                  },
                },
              ],
              filter: [],
            },
          },
          aggs: {
            inLanguage: { terms: { field: 'inLanguage.keyword', size: 20 } },
            mediaType: { terms: { field: 'mediaType.keyword', size: 20 } },
            communicationMode: { terms: { field: 'communicationMode.keyword', size: 20 } },
            entityType: { terms: { field: 'entityType.keyword', size: 20 } },
          },
          highlight: {
            fields: {
              name: {},
              description: {},
            },
          },
          sort: undefined,
          from: 0,
          size: 100,
        },
      });
    });

    it('should perform advanced search with query string', async () => {
      const mockSearchResponse = {
        body: {
          took: 5,
          hits: {
            total: { value: 0 },
            hits: [],
          },
          aggregations: {},
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      prisma.entity.findMany.mockResolvedValue([]);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'name:test AND description:entity',
          searchType: 'advanced',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(opensearch.search).toHaveBeenCalledWith({
        index: 'entities',
        body: {
          query: {
            bool: {
              must: [
                {
                  query_string: {
                    query: 'name:test AND description:entity',
                    fields: ['name^2', 'description'],
                    default_operator: 'AND',
                  },
                },
              ],
              filter: [],
            },
          },
          aggs: {
            inLanguage: { terms: { field: 'inLanguage.keyword', size: 20 } },
            mediaType: { terms: { field: 'mediaType.keyword', size: 20 } },
            communicationMode: { terms: { field: 'communicationMode.keyword', size: 20 } },
            entityType: { terms: { field: 'entityType.keyword', size: 20 } },
          },
          highlight: {
            fields: {
              name: {},
              description: {},
            },
          },
          sort: undefined,
          from: 0,
          size: 100,
        },
      });
    });

    it('should apply filters correctly', async () => {
      const mockSearchResponse = {
        body: {
          took: 8,
          hits: {
            total: { value: 0 },
            hits: [],
          },
          aggregations: {},
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      prisma.entity.findMany.mockResolvedValue([]);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          filters: {
            entityType: ['http://pcdm.org/models#Collection'],
            inLanguage: ['en', 'fr'],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const expectedFilters = [
        {
          terms: {
            entityType: ['http://pcdm.org/models#Collection'],
          },
        },
        {
          terms: {
            inLanguage: ['en', 'fr'],
          },
        },
      ];

      expect(opensearch.search).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              bool: expect.objectContaining({
                filter: expectedFilters,
              }),
            }),
          }),
        }),
      );
    });

    it('should handle geospatial search with bounding box', async () => {
      const mockSearchResponse = {
        body: {
          took: 12,
          hits: {
            total: { value: 0 },
            hits: [],
          },
          aggregations: {
            geohash_grid: {
              buckets: [
                { key: 'gbsuv', doc_count: 3 },
                { key: 'gbsvb', doc_count: 1 },
              ],
            },
          },
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      prisma.entity.findMany.mockResolvedValue([]);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          boundingBox: {
            topRight: { lat: 51.5, lng: 0.1 },
            bottomLeft: { lat: 51.4, lng: 0.0 },
          },
          geohashPrecision: 5,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { geohashGrid: Record<string, number> };
      expect(body.geohashGrid).toEqual({
        gbsuv: 3,
        gbsvb: 1,
      });

      expect(opensearch.search).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            query: expect.objectContaining({
              bool: expect.objectContaining({
                filter: [
                  {
                    geo_bounding_box: {
                      location: {
                        top_left: { lat: 51.5, lon: 0.0 },
                        bottom_right: { lat: 51.4, lon: 0.1 },
                      },
                    },
                  },
                ],
              }),
            }),
            aggs: expect.objectContaining({
              geohash_grid: {
                geohash_grid: {
                  field: 'location',
                  precision: 5,
                  bounds: {
                    top_left: { lat: 51.5, lon: 0.0 },
                    bottom_right: { lat: 51.4, lon: 0.1 },
                  },
                },
              },
            }),
          }),
        }),
      );
    });

    it('should handle pagination and sorting', async () => {
      const mockSearchResponse = {
        body: {
          took: 6,
          hits: {
            total: { value: 0 },
            hits: [],
          },
          aggregations: {},
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      prisma.entity.findMany.mockResolvedValue([]);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          limit: 50,
          offset: 20,
          sort: 'name',
          order: 'desc',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(opensearch.search).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            from: 20,
            size: 50,
            sort: [{ 'name.keyword': 'desc' }],
          }),
        }),
      );
    });

    it('should return 422 for malformed opensearch query', async () => {
      const opensearchError = Object.assign(new Error('parsing_exception'), { statusCode: 400 });
      opensearch.search.mockRejectedValue(opensearchError);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          searchType: 'advanced',
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body) as StandardErrorResponse;
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('should handle opensearch errors', async () => {
      opensearch.search.mockRejectedValue(new Error('OpenSearch connection failed'));

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body).toMatchSnapshot();
    });

    it('should return 422 for malformed opensearch query', async () => {
      const error = new Error('parsing_exception') as Error & { statusCode: number };
      error.statusCode = 400;
      opensearch.search.mockRejectedValue(error);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body) as StandardErrorResponse;
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe('parsing_exception');
    });

    it('should validate required query parameter', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should fall back to OpenSearch _source when entity not in database (Map View tooltip support)', async () => {
      const mockEntities = [
        {
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'A test entity',
          entityType: 'http://pcdm.org/models#Collection',
          memberOf: null,
          rootCollection: null,
          metadataLicenseId: null,
          contentLicenseId: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
        // Entity 2 is missing from database — must still appear in response via _source fallback
      ];

      const mockSearchResponse = {
        body: {
          took: 10,
          hits: {
            total: { value: 2 },
            hits: [
              {
                _score: 1.5,
                _source: {
                  id: 'http://example.com/entity/1',
                },
                highlight: {},
              },
              {
                _score: 1.2,
                _source: {
                  id: 'http://example.com/entity/2',
                  name: ['Interview with Patricia Parker'],
                  description: ['oral history interview'],
                  entityType: ['RepositoryObject'],
                },
                highlight: {},
              },
            ],
          },
          aggregations: {},
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      // @ts-expect-error TS is looking at the wrong function signature
      prisma.entity.findMany.mockResolvedValue(mockEntities);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Both entities returned; OS-only one carries name/type from _source
      expect(body.entities).toHaveLength(2);
      expect(body.entities[0].id).toBe('http://example.com/entity/1');
      expect(body.entities[1]).toMatchObject({
        id: 'http://example.com/entity/2',
        name: 'Interview with Patricia Parker',
        entityType: 'RepositoryObject',
        memberOf: null,
        rootCollection: null,
        access: { metadata: true, content: false },
        counts: { collections: 0, objects: 0, files: 0 },
        searchExtra: { score: 1.2 },
      });
      expect(body).toMatchSnapshot();
    });

    it('OS-only fallback handles missing/scalar/empty fields gracefully', async () => {
      // Covers pickStr branches: undefined, scalar string, and empty-array name
      const mockSearchResponse = {
        body: {
          took: 1,
          hits: {
            total: { value: 3 },
            hits: [
              { _score: 1, _source: { id: 'os-only-1' /* no name/desc/type at all */ }, highlight: {} },
              { _score: 1, _source: { id: 'os-only-2', name: 'scalar-name', entityType: 'Dataset' }, highlight: {} },
              { _score: 1, _source: { id: 'os-only-3', name: [] }, highlight: {} },
            ],
          },
          aggregations: {},
        },
      };
      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      // @ts-expect-error TS is looking at the wrong function signature
      prisma.entity.findMany.mockResolvedValue([]);

      const response = await fastify.inject({ method: 'POST', url: '/search', payload: { query: 't' } });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.entities).toHaveLength(3);
      // Falls back to id when name absent or empty array
      expect(body.entities[0].name).toBe('os-only-1');
      expect(body.entities[0].entityType).toBe('');
      // Scalar string is preserved
      expect(body.entities[1].name).toBe('scalar-name');
      expect(body.entities[1].entityType).toBe('Dataset');
      // Empty array falls back to id
      expect(body.entities[2].name).toBe('os-only-3');
    });

    it('should handle missing id in search hit', async () => {
      const mockSearchResponse = {
        body: {
          took: 5,
          hits: {
            total: { value: 1 },
            hits: [
              {
                _score: 1.5,
                _source: {
                  // Missing id
                },
              },
            ],
          },
          aggregations: {},
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      prisma.entity.findMany.mockResolvedValue([]);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });

      expect(response.statusCode).toBe(500);
      console.log(response.body);
    });

    it('should handle id explicitly set to undefined', async () => {
      const mockSearchResponse = {
        body: {
          took: 5,
          hits: {
            total: { value: 1 },
            hits: [
              {
                _score: 1.5,
                _source: {
                  id: undefined,
                  name: 'Test Entity',
                },
              },
            ],
          },
          aggregations: {},
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body).toMatchSnapshot();
    });

    it('should handle invalid search response with missing hits data', async () => {
      const mockSearchResponse = {
        body: {
          took: 5,
          // Missing hits object
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Search failed');
    });

    it('should apply custom entity transformers', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: fine in tests
      const customTransformer = async (entity: any) => ({
        ...entity,
        tested: true,
      });

      await fastifyBefore();
      await fastify.register(searchRoute, {
        prisma,
        opensearch,
        accessTransformer: AllPublicAccessTransformer,
        entityTransformers: [customTransformer],
      });

      const mockEntities = [
        {
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'A test entity',
          entityType: 'http://pcdm.org/models#Collection',
          memberOf: null,
          rootCollection: null,
          metadataLicenseId: null,
          contentLicenseId: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ];

      const mockSearchResponse = {
        body: {
          took: 10,
          hits: {
            total: { value: 1 },
            hits: [
              {
                _score: 1.5,
                _source: {
                  id: 'http://example.com/entity/1',
                },
                highlight: {},
              },
            ],
          },
          aggregations: {},
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      // @ts-expect-error TS is looking at the wrong function signature
      prisma.entity.findMany.mockResolvedValue(mockEntities);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });

      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchSnapshot();
    });

    it('should handle search response with no aggregations field', async () => {
      const mockEntities = [
        {
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'A test entity',
          entityType: 'http://pcdm.org/models#Collection',
          memberOf: null,
          rootCollection: null,
          metadataLicenseId: null,
          contentLicenseId: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ];

      const mockSearchResponse = {
        body: {
          took: 10,
          hits: {
            total: { value: 1 },
            hits: [
              {
                _score: 1.5,
                _source: {
                  id: 'http://example.com/entity/1',
                },
                highlight: {},
              },
            ],
          },
          // No aggregations field
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      // @ts-expect-error TS is looking at the wrong function signature
      prisma.entity.findMany.mockResolvedValue(mockEntities);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });
      const body = JSON.parse(response.body) as { facets?: unknown; geohashGrid?: unknown; entities: unknown[] };

      expect(response.statusCode).toBe(200);
      expect(body.facets).toBeUndefined();
      expect(body.geohashGrid).toBeUndefined();
      expect(body.entities).toHaveLength(1);
    });

    it('should handle search response with malformed aggregation buckets', async () => {
      const mockEntities = [
        {
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'A test entity',
          entityType: 'http://pcdm.org/models#Collection',
          memberOf: null,
          rootCollection: null,
          metadataLicenseId: null,
          contentLicenseId: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ];

      const mockSearchResponse = {
        body: {
          took: 10,
          hits: {
            total: { value: 1 },
            hits: [
              {
                _score: 1.5,
                _source: {
                  id: 'http://example.com/entity/1',
                },
                highlight: {},
              },
            ],
          },
          aggregations: {
            entityType: {
              // buckets is not an array
              buckets: null,
            },
            inLanguage: {
              // buckets is undefined
            },
          },
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      // @ts-expect-error TS is looking at the wrong function signature
      prisma.entity.findMany.mockResolvedValue(mockEntities);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });
      const body = JSON.parse(response.body) as { facets?: unknown; entities: unknown[] };

      expect(response.statusCode).toBe(200);
      expect(body.facets).toBeUndefined();
      expect(body.entities).toHaveLength(1);
    });

    it('should handle search response with malformed geohash aggregation buckets', async () => {
      const mockEntities = [
        {
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'A test entity',
          entityType: 'http://pcdm.org/models#Collection',
          memberOf: null,
          rootCollection: null,
          metadataLicenseId: null,
          contentLicenseId: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ];

      const mockSearchResponse = {
        body: {
          took: 10,
          hits: {
            total: { value: 1 },
            hits: [
              {
                _score: 1.5,
                _source: {
                  id: 'http://example.com/entity/1',
                },
                highlight: {},
              },
            ],
          },
          aggregations: {
            geohash_grid: {
              // buckets is not an array
              buckets: 'invalid',
            },
          },
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      // @ts-expect-error TS is looking at the wrong function signature
      prisma.entity.findMany.mockResolvedValue(mockEntities);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });
      const body = JSON.parse(response.body) as { geohashGrid?: unknown; entities: unknown[] };

      expect(response.statusCode).toBe(200);
      expect(body.geohashGrid).toBeUndefined();
      expect(body.entities).toHaveLength(1);
    });

    it('should return null for memberOf/rootCollection when parent entity not found', async () => {
      const mockEntities = [
        {
          meta: {},
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'Entity with missing parent',
          entityType: 'http://pcdm.org/models#Object',
          memberOf: 'http://example.com/entity/deleted',
          rootCollection: 'http://example.com/entity/deleted',
          metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ];

      const mockSearchResponse = {
        body: {
          took: 10,
          hits: {
            total: { value: 1 },
            hits: [
              {
                _score: 1.5,
                _source: {
                  id: 'http://example.com/entity/1',
                },
              },
            ],
          },
          aggregations: {},
        },
      };

      // @ts-expect-error TS is looking at the wrong function signature
      opensearch.search.mockResolvedValue(mockSearchResponse);
      // First findMany returns the entities, second (for reference resolution) returns empty
      prisma.entity.findMany.mockResolvedValueOnce(mockEntities);
      prisma.entity.findMany.mockResolvedValueOnce([]);

      const response = await fastify.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
        },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchSnapshot();
    });
  });
});
