import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { baseEntityTransformer, resolveEntityReferences } from '../transformers/default.js';
import type { AccessTransformer, EntityTransformer } from '../types/transformers.js';
import { createInternalError, createNotFoundError } from '../utils/errors.js';

const paramsSchema = z.object({
  id: z.url(),
});

type EntityRouteOptions = {
  accessTransformer: AccessTransformer;
  entityTransformers?: EntityTransformer[];
};

const entity: FastifyPluginAsync<EntityRouteOptions> = async (fastify, opts) => {
  const { accessTransformer, entityTransformers = [] } = opts;
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/entity/:id',
    {
      schema: {
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const entity = await fastify.prisma.entity.findUnique({
          where: { id },
          include: { file: { select: { id: true } } },
        });

        if (!entity) {
          try {
            const osRes = (await fastify.opensearch.get({ index: 'entities', id })) as {
              body?: { found?: boolean; _source?: Record<string, unknown> };
            };
            if (osRes.body?.found && osRes.body._source) {
              const src = osRes.body._source;
              const pickStr = (v: unknown): string =>
                Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v);
              return {
                id,
                name: pickStr(src.name) || id,
                description: pickStr(src.description),
                entityType: pickStr(src.entityType),
                memberOf: null,
                rootCollection: null,
                metadataLicenseId: pickStr(src.metadataLicenseId),
                contentLicenseId: pickStr(src.contentLicenseId),
                access: { metadata: true, content: false },
                counts: { collections: 0, objects: 0, files: 0 },
              };
            }
          } catch {
            // fall through to 404
          }
          return reply.code(404).send(createNotFoundError('The requested entity was not found', id));
        }

        // Resolve memberOf and rootCollection references
        const refMap = await resolveEntityReferences([entity], fastify.prisma);

        const base = baseEntityTransformer(entity);
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

        return result;
      } catch (error) {
        const err = error as Error;
        fastify.log.error(`Database error: ${err.message}`);

        return reply.code(500).send(createInternalError());
      }
    },
  );
};

export default entity;
