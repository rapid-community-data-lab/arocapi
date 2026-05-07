import { describe, expect, it } from 'vitest';
import { OpensearchQueryBuilder } from './queryBuilder.js';

const bbox = {
  topRight: { lat: 10, lng: 20 },
  bottomLeft: { lat: -10, lng: -20 },
};

describe('OpensearchQueryBuilder', () => {
  describe('buildQuery', () => {
    it('builds a basic multi_match query', () => {
      const q = new OpensearchQueryBuilder().buildQuery('basic', 'hello');
      expect(q.bool.must).toHaveLength(1);
      expect(q.bool.must?.[0]).toHaveProperty('multi_match');
      expect(q.bool.filter).toEqual([]);
    });

    it('builds an advanced query_string query', () => {
      const q = new OpensearchQueryBuilder().buildQuery('advanced', 'name:foo');
      expect(q.bool.must?.[0]).toHaveProperty('query_string');
    });

    it('adds term filters for each filter entry', () => {
      const q = new OpensearchQueryBuilder().buildQuery('basic', '', { entityType: ['A', 'B'] });
      expect(q.bool.filter).toEqual([{ terms: { entityType: ['A', 'B'] } }]);
    });

    it('adds a geo_bounding_box filter on the location field when boundingBox is provided', () => {
      const q = new OpensearchQueryBuilder().buildQuery('basic', '', undefined, bbox);
      expect(q.bool.filter).toEqual([
        {
          geo_bounding_box: {
            location: {
              top_left: { lat: 10, lon: -20 },
              bottom_right: { lat: -10, lon: 20 },
            },
          },
        },
      ]);
    });
  });

  describe('buildAggregations', () => {
    it('returns the configured aggregations when no geohash precision/boundingBox', () => {
      const aggs = new OpensearchQueryBuilder().buildAggregations();
      expect(aggs).not.toHaveProperty('geohash_grid');
      expect(aggs).toHaveProperty('entityType');
    });

    it('adds a geohash_grid aggregation on the location field when precision+bbox provided (Map View)', () => {
      const aggs = new OpensearchQueryBuilder().buildAggregations(5, bbox);
      expect(aggs).toHaveProperty('geohash_grid');
      expect(aggs.geohash_grid).toEqual({
        geohash_grid: {
          field: 'location',
          precision: 5,
          bounds: {
            top_left: { lat: 10, lon: -20 },
            bottom_right: { lat: -10, lon: 20 },
          },
        },
      });
    });

    it('does not add geohash_grid when only precision is provided', () => {
      const aggs = new OpensearchQueryBuilder().buildAggregations(5);
      expect(aggs).not.toHaveProperty('geohash_grid');
    });

    it('honours custom aggregations passed via constructor options', () => {
      const custom = { foo: { terms: { field: 'bar' } } };
      const aggs = new OpensearchQueryBuilder({ aggregations: custom }).buildAggregations();
      expect(aggs).toEqual(custom);
    });
  });

  describe('buildSort', () => {
    it('returns undefined for relevance', () => {
      expect(new OpensearchQueryBuilder().buildSort('relevance', 'asc')).toBeUndefined();
    });

    it('sorts by name.keyword for name sort', () => {
      expect(new OpensearchQueryBuilder().buildSort('name', 'desc')).toEqual([{ 'name.keyword': 'desc' }]);
    });

    it('sorts by the field name for other fields', () => {
      expect(new OpensearchQueryBuilder().buildSort('createdAt', 'asc')).toEqual([{ createdAt: 'asc' }]);
    });
  });
});
