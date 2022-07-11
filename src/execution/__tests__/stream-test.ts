import { assert } from 'chai';
import { describe, it } from 'mocha';

import { expectJSON } from '../../__testUtils__/expectJSON';
import { resolveOnNextTick } from '../../__testUtils__/resolveOnNextTick';

import { isAsyncIterable } from '../../jsutils/isAsyncIterable';

import type { DocumentNode } from '../../language/ast';
import { parse } from '../../language/parser';

import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from '../../type/definition';
import { GraphQLID, GraphQLString } from '../../type/scalars';
import { GraphQLSchema } from '../../type/schema';

import { execute } from '../execute';

const friendType = new GraphQLObjectType({
  fields: {
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    asyncName: {
      type: GraphQLString,
      async resolve(rootValue) {
        // wait for parent stream to close
        await new Promise((r) => setTimeout(r, 0));
        return rootValue.name;
      },
    },
  },
  name: 'Friend',
});

const friends = [
  { name: 'Luke', id: 1 },
  { name: 'Han', id: 2 },
  { name: 'Leia', id: 3 },
];

const query = new GraphQLObjectType({
  fields: {
    scalarList: {
      type: new GraphQLList(GraphQLString),
      resolve: () => ['apple', 'banana', 'coconut'],
    },
    scalarListList: {
      type: new GraphQLList(new GraphQLList(GraphQLString)),
      resolve: () => [
        ['apple', 'apple', 'apple'],
        ['banana', 'banana', 'banana'],
        ['coconut', 'coconut', 'coconut'],
      ],
    },
    asyncList: {
      type: new GraphQLList(friendType),
      resolve: () => friends.map((f) => Promise.resolve(f)),
    },
    asyncSlowList: {
      type: new GraphQLList(friendType),
      resolve: () =>
        friends.map(async (f, i) => {
          if (i === 0) {
            await resolveOnNextTick();
          }
          return f;
        }),
    },
    nonNullError: {
      type: new GraphQLList(new GraphQLNonNull(friendType)),
      resolve: () => [friends[0], null],
    },
    nonNullAsyncError: {
      type: new GraphQLList(
        new GraphQLNonNull(
          new GraphQLObjectType({
            name: 'nonNullAsyncErrorListItem',
            fields: {
              string: {
                type: new GraphQLNonNull(GraphQLString),
                resolve: (root) => {
                  if (root.string === 'error') {
                    return Promise.reject(new Error('Oops'));
                  }
                  return Promise.resolve(root.string);
                },
              },
            },
          }),
        ),
      ),
      resolve() {
        return [
          { string: friends[0].name },
          { string: 'error' },
          { string: friends[1].name },
        ];
      },
    },
    asyncListError: {
      type: new GraphQLList(friendType),
      resolve: () =>
        friends.map((f, i) => {
          if (i === 1) {
            return Promise.reject(new Error('bad'));
          }
          return Promise.resolve(f);
        }),
    },
    asyncIterableList: {
      type: new GraphQLList(friendType),
      async *resolve() {
        yield await Promise.resolve(friends[0]);
        yield await Promise.resolve(friends[1]);
        yield await Promise.resolve(friends[2]);
      },
    },
    asyncIterableError: {
      type: new GraphQLList(friendType),
      async *resolve() {
        yield await Promise.resolve(friends[0]);
        throw new Error('bad');
      },
    },
    asyncIterableNonNullError: {
      type: new GraphQLList(new GraphQLNonNull(friendType)),
      async *resolve() {
        yield await Promise.resolve(friends[0]);
        yield await Promise.resolve(null);
        yield await Promise.resolve(friends[1]);
      },
    },
    asyncIterableInvalid: {
      type: new GraphQLList(GraphQLString),
      async *resolve() {
        yield await Promise.resolve(friends[0].name);
        yield await Promise.resolve({});
      },
    },
    asyncIterableAsyncInvalid: {
      type: new GraphQLList(
        new GraphQLObjectType({
          name: 'asyncIterableAsyncInvalidListItem',
          fields: {
            string: {
              type: new GraphQLNonNull(GraphQLString),
              resolve: (root) => {
                if (root.string === 'error') {
                  return Promise.reject(new Error('Oops'));
                }
                return Promise.resolve(root.string);
              },
            },
          },
        }),
      ),
      async *resolve() {
        yield await Promise.resolve({ string: friends[0].name });
        yield await Promise.resolve({ string: 'error' });
        yield await Promise.resolve({ string: friends[1].name });
      },
    },
    asyncIterableListDelayed: {
      type: new GraphQLList(friendType),
      async *resolve() {
        for (const friend of friends) {
          // pause an additional ms before yielding to allow time
          // for tests to return or throw before next value is processed.
          // eslint-disable-next-line no-await-in-loop
          await resolveOnNextTick();
          yield friend; /* c8 ignore start */
          // Not reachable, early return
        }
      } /* c8 ignore stop */,
    },
    asyncIterableListNoReturn: {
      type: new GraphQLList(friendType),
      resolve() {
        let i = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            async next() {
              const friend = friends[i++];
              if (friend) {
                await resolveOnNextTick();
                return { value: friend, done: false };
              }
              return { value: undefined, done: true };
            },
          }),
        };
      },
    },
    asyncIterableListDelayedClose: {
      type: new GraphQLList(friendType),
      async *resolve() {
        for (const friend of friends) {
          yield friend;
        }
        await new Promise((r) => setTimeout(r, 0));
      },
    },
    nestedObject: {
      type: new GraphQLObjectType({
        name: 'NestedObject',
        fields: {
          slowField: {
            type: GraphQLString,
            resolve: async () => {
              await resolveOnNextTick();
              return 'slow';
            },
          },
          asyncIterableList: {
            type: new GraphQLList(friendType),
            async *resolve() {
              yield await Promise.resolve(friends[0]);
              yield await Promise.resolve(friends[1]);
              yield await Promise.resolve(friends[2]);
            },
          },
        },
      }),
      resolve: () => ({}),
    },
  },
  name: 'Query',
});

async function complete(document: DocumentNode, rootValue: unknown = {}) {
  const schema = new GraphQLSchema({ query });
  const result = await execute({ schema, document, rootValue });

  if (isAsyncIterable(result)) {
    const results = [];
    for await (const patch of result) {
      results.push(patch);
    }
    return results;
  }
  return result;
}

async function completeAsync(document: DocumentNode, numCalls: number) {
  const schema = new GraphQLSchema({ query });

  const result = await execute({ schema, document, rootValue: {} });

  assert(isAsyncIterable(result));

  const iterator = result[Symbol.asyncIterator]();

  const promises = [];
  for (let i = 0; i < numCalls; i++) {
    promises.push(iterator.next());
  }
  return Promise.all(promises);
}

describe('Execute: stream directive', () => {
  it('Can stream a list field', async () => {
    const document = parse('{ scalarList @stream(initialCount: 1) }');
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          scalarList: ['apple'],
        },
        hasNext: true,
      },
      {
        incremental: [{ items: ['banana'], path: ['scalarList', 1] }],
        hasNext: true,
      },
      {
        incremental: [{ items: ['coconut'], path: ['scalarList', 2] }],
        hasNext: false,
      },
    ]);
  });
  it('Can use default value of initialCount', async () => {
    const document = parse('{ scalarList @stream }');
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          scalarList: [],
        },
        hasNext: true,
      },
      {
        incremental: [{ items: ['apple'], path: ['scalarList', 0] }],
        hasNext: true,
      },
      {
        incremental: [{ items: ['banana'], path: ['scalarList', 1] }],
        hasNext: true,
      },
      {
        incremental: [{ items: ['coconut'], path: ['scalarList', 2] }],
        hasNext: false,
      },
    ]);
  });
  it('Negative values of initialCount throw field errors', async () => {
    const document = parse('{ scalarList @stream(initialCount: -2) }');
    const result = await complete(document);
    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'initialCount must be a positive integer',
          locations: [
            {
              line: 1,
              column: 3,
            },
          ],
          path: ['scalarList'],
        },
      ],
      data: {
        scalarList: null,
      },
    });
  });
  it('Returns label from stream directive', async () => {
    const document = parse(
      '{ scalarList @stream(initialCount: 1, label: "scalar-stream") }',
    );
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          scalarList: ['apple'],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: ['banana'],
            path: ['scalarList', 1],
            label: 'scalar-stream',
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: ['coconut'],
            path: ['scalarList', 2],
            label: 'scalar-stream',
          },
        ],
        hasNext: false,
      },
    ]);
  });
  it('Can disable @stream using if argument', async () => {
    const document = parse(
      '{ scalarList @stream(initialCount: 0, if: false) }',
    );
    const result = await complete(document);

    expectJSON(result).toDeepEqual({
      data: { scalarList: ['apple', 'banana', 'coconut'] },
    });
  });
  it('Can stream multi-dimensional lists', async () => {
    const document = parse('{ scalarListList @stream(initialCount: 1) }');
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          scalarListList: [['apple', 'apple', 'apple']],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [['banana', 'banana', 'banana']],
            path: ['scalarListList', 1],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [['coconut', 'coconut', 'coconut']],
            path: ['scalarListList', 2],
          },
        ],
        hasNext: false,
      },
    ]);
  });

  it('Can stream a field that returns a list of promises', async () => {
    const document = parse(`
      query { 
        asyncList @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncList: [
            {
              name: 'Luke',
              id: '1',
            },
            {
              name: 'Han',
              id: '2',
            },
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Leia',
                id: '3',
              },
            ],
            path: ['asyncList', 2],
          },
        ],
        hasNext: false,
      },
    ]);
  });
  it('Can stream in correct order with lists of promises', async () => {
    const document = parse(`
      query { 
        asyncSlowList @stream(initialCount: 0) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncSlowList: [],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Luke',
                id: '1',
              },
            ],
            path: ['asyncSlowList', 0],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Han',
                id: '2',
              },
            ],
            path: ['asyncSlowList', 1],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Leia',
                id: '3',
              },
            ],
            path: ['asyncSlowList', 2],
          },
        ],
        hasNext: false,
      },
    ]);
  });
  it('Handles rejections in a field that returns a list of promises before initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncListError @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        errors: [
          {
            message: 'bad',
            locations: [
              {
                line: 3,
                column: 9,
              },
            ],
            path: ['asyncListError', 1],
          },
        ],
        data: {
          asyncListError: [
            {
              name: 'Luke',
              id: '1',
            },
            null,
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Leia',
                id: '3',
              },
            ],
            path: ['asyncListError', 2],
          },
        ],
        hasNext: false,
      },
    ]);
  });
  it('Handles rejections in a field that returns a list of promises after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncListError @stream(initialCount: 1) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncListError: [
            {
              name: 'Luke',
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [null],
            path: ['asyncListError', 1],
            errors: [
              {
                message: 'bad',
                locations: [
                  {
                    line: 3,
                    column: 9,
                  },
                ],
                path: ['asyncListError', 1],
              },
            ],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Leia',
                id: '3',
              },
            ],
            path: ['asyncListError', 2],
          },
        ],
        hasNext: false,
      },
    ]);
  });
  it('Can stream a field that returns an async iterable', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableList: [],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Luke',
                id: '1',
              },
            ],
            path: ['asyncIterableList', 0],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Han',
                id: '2',
              },
            ],
            path: ['asyncIterableList', 1],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Leia',
                id: '3',
              },
            ],
            path: ['asyncIterableList', 2],
          },
        ],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Can stream a field that returns an async iterable, using a non-zero initialCount', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableList: [
            {
              name: 'Luke',
              id: '1',
            },
            {
              name: 'Han',
              id: '2',
            },
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Leia',
                id: '3',
              },
            ],
            path: ['asyncIterableList', 2],
          },
        ],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Negative values of initialCount throw field errors on a field that returns an async iterable', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream(initialCount: -2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'initialCount must be a positive integer',
          locations: [
            {
              line: 3,
              column: 9,
            },
          ],
          path: ['asyncIterableList'],
        },
      ],
      data: {
        asyncIterableList: null,
      },
    });
  });
  it('Can handle concurrent calls to .next() without waiting', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await completeAsync(document, 4);
    expectJSON(result).toDeepEqual([
      {
        done: false,
        value: {
          data: {
            asyncIterableList: [
              {
                name: 'Luke',
                id: '1',
              },
              {
                name: 'Han',
                id: '2',
              },
            ],
          },
          hasNext: true,
        },
      },
      {
        done: false,
        value: {
          incremental: [
            {
              items: [
                {
                  name: 'Leia',
                  id: '3',
                },
              ],
              path: ['asyncIterableList', 2],
            },
          ],
          hasNext: true,
        },
      },
      {
        done: false,
        value: {
          hasNext: false,
        },
      },
      {
        done: true,
        value: undefined,
      },
    ]);
  });
  it('Handles error thrown in async iterable before initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableError @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'bad',
          locations: [
            {
              line: 3,
              column: 9,
            },
          ],
          path: ['asyncIterableError', 1],
        },
      ],
      data: {
        asyncIterableError: [
          {
            name: 'Luke',
            id: '1',
          },
          null,
        ],
      },
    });
  });
  it('Handles error thrown in async iterable after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableError @stream(initialCount: 1) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableError: [
            {
              name: 'Luke',
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [null],
            path: ['asyncIterableError', 1],
            errors: [
              {
                message: 'bad',
                locations: [
                  {
                    line: 3,
                    column: 9,
                  },
                ],
                path: ['asyncIterableError', 1],
              },
            ],
          },
        ],
        hasNext: false,
      },
    ]);
  });

  it('Handles null returned in non-null list items after initialCount is reached', async () => {
    const document = parse(`
      query { 
        nonNullError @stream(initialCount: 1) {
          name
        }
      }
    `);
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          nonNullError: [
            {
              name: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: null,
            path: ['nonNullError', 1],
            errors: [
              {
                message:
                  'Cannot return null for non-nullable field Query.nonNullError.',
                locations: [
                  {
                    line: 3,
                    column: 9,
                  },
                ],
                path: ['nonNullError', 1],
              },
            ],
          },
        ],
        hasNext: false,
      },
    ]);
  });

  it('Handles null returned in non-null async iterable list items after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableNonNullError @stream(initialCount: 1) {
          name
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableNonNullError: [
            {
              name: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: null,
            path: ['asyncIterableNonNullError', 1],
            errors: [
              {
                message:
                  'Cannot return null for non-nullable field Query.asyncIterableNonNullError.',
                locations: [
                  {
                    line: 3,
                    column: 9,
                  },
                ],
                path: ['asyncIterableNonNullError', 1],
              },
            ],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Han',
              },
            ],
            path: ['asyncIterableNonNullError', 2],
          },
        ],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Handles errors thrown by completeValue after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableInvalid @stream(initialCount: 1)
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableInvalid: ['Luke'],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [null],
            path: ['asyncIterableInvalid', 1],
            errors: [
              {
                message: 'String cannot represent value: {}',
                locations: [
                  {
                    line: 3,
                    column: 9,
                  },
                ],
                path: ['asyncIterableInvalid', 1],
              },
            ],
          },
        ],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });

  it('Handles async errors thrown by completeValue after initialCount is reached', async () => {
    const document = parse(`
      query { 
        nonNullAsyncError @stream(initialCount: 1) {
          string
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          nonNullAsyncError: [{ string: 'Luke' }],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: null,
            path: ['nonNullAsyncError', 1],
            errors: [
              {
                message: 'Oops',
                locations: [
                  {
                    line: 4,
                    column: 11,
                  },
                ],
                path: ['nonNullAsyncError', 1, 'string'],
              },
            ],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                string: 'Han',
              },
            ],
            path: ['nonNullAsyncError', 2],
          },
        ],
        hasNext: false,
      },
    ]);
  });

  it('Handles async errors thrown by completeValue after initialCount is reached from async iterable', async () => {
    const document = parse(`
      query { 
        asyncIterableAsyncInvalid @stream(initialCount: 1) {
          string
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableAsyncInvalid: [{ string: 'Luke' }],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [null],
            path: ['asyncIterableAsyncInvalid', 1],
            errors: [
              {
                message: 'Oops',
                locations: [
                  {
                    line: 4,
                    column: 11,
                  },
                ],
                path: ['asyncIterableAsyncInvalid', 1, 'string'],
              },
            ],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                string: 'Han',
              },
            ],
            path: ['asyncIterableAsyncInvalid', 2],
          },
        ],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });

  it('Handles promises returned by completeValue after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream(initialCount: 1) {
          name
          asyncName
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableList: [
            {
              name: 'Luke',
              asyncName: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Han',
                asyncName: 'Han',
              },
            ],
            path: ['asyncIterableList', 1],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                name: 'Leia',
                asyncName: 'Leia',
              },
            ],
            path: ['asyncIterableList', 2],
          },
        ],
        hasNext: false,
      },
    ]);
  });
  it('Returns payloads in correct order when parent deferred fragment resolves slower than stream', async () => {
    const document = parse(`
      query { 
        nestedObject {
          ... DeferFragment @defer
        }
      }
      fragment DeferFragment on NestedObject {
        slowField
        asyncIterableList @stream(initialCount: 0) {
          name
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          nestedObject: {},
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            data: {
              slowField: 'slow',
              asyncIterableList: [],
            },
            path: ['nestedObject'],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [{ name: 'Luke' }],
            path: ['nestedObject', 'asyncIterableList', 0],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [{ name: 'Han' }],
            path: ['nestedObject', 'asyncIterableList', 1],
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [{ name: 'Leia' }],
            path: ['nestedObject', 'asyncIterableList', 2],
          },
        ],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Can @defer fields that are resolved after async iterable is complete', async () => {
    const document = parse(`
    query { 
      asyncIterableList @stream(initialCount: 1, label:"stream-label") {
        ...NameFragment @defer(label: "DeferName") @defer(label: "DeferName")
        id
      }
    }
    fragment NameFragment on Friend {
      asyncName
    }
  `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableList: [
            {
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                id: '2',
              },
            ],
            path: ['asyncIterableList', 1],
            label: 'stream-label',
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                id: '3',
              },
            ],
            path: ['asyncIterableList', 2],
            label: 'stream-label',
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            data: {
              asyncName: 'Luke',
            },
            path: ['asyncIterableList', 0],
            label: 'DeferName',
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            data: {
              asyncName: 'Han',
            },
            path: ['asyncIterableList', 1],
            label: 'DeferName',
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            data: {
              asyncName: 'Leia',
            },
            path: ['asyncIterableList', 2],
            label: 'DeferName',
          },
        ],
        hasNext: false,
      },
    ]);
  });
  it('Can @defer fields that are resolved before async iterable is complete', async () => {
    const document = parse(`
    query { 
      asyncIterableListDelayedClose @stream(initialCount: 1, label:"stream-label") {
        ...NameFragment @defer(label: "DeferName") @defer(label: "DeferName")
        id
      }
    }
    fragment NameFragment on Friend {
      name
    }
  `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableListDelayedClose: [
            {
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
      {
        incremental: [
          {
            data: {
              name: 'Luke',
            },
            path: ['asyncIterableListDelayedClose', 0],
            label: 'DeferName',
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                id: '2',
              },
            ],
            path: ['asyncIterableListDelayedClose', 1],
            label: 'stream-label',
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            items: [
              {
                id: '3',
              },
            ],
            path: ['asyncIterableListDelayedClose', 2],
            label: 'stream-label',
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            data: {
              name: 'Han',
            },
            path: ['asyncIterableListDelayedClose', 1],
            label: 'DeferName',
          },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            data: {
              name: 'Leia',
            },
            path: ['asyncIterableListDelayedClose', 2],
            label: 'DeferName',
          },
        ],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Returns underlying async iterables when returned generator is returned', async () => {
    const document = parse(`
      query { 
        asyncIterableListDelayed @stream(initialCount: 1) {
          id
          ... @defer {
            name
          }
        }
      }
    `);
    const schema = new GraphQLSchema({ query });

    const executeResult = await execute({ schema, document, rootValue: {} });
    assert(isAsyncIterable(executeResult));
    const iterator = executeResult[Symbol.asyncIterator]();

    const result1 = await iterator.next();
    expectJSON(result1).toDeepEqual({
      done: false,
      value: {
        data: {
          asyncIterableListDelayed: [
            {
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
    });
    const returnPromise = iterator.return();

    // these results had started processing before return was called
    const result2 = await iterator.next();
    expectJSON(result2).toDeepEqual({
      done: false,
      value: {
        incremental: [
          {
            data: {
              name: 'Luke',
            },
            path: ['asyncIterableListDelayed', 0],
          },
        ],
        hasNext: true,
      },
    });
    const result3 = await iterator.next();
    expectJSON(result3).toDeepEqual({
      done: false,
      value: {
        incremental: [
          {
            items: [
              {
                id: '2',
              },
            ],
            path: ['asyncIterableListDelayed', 1],
          },
        ],
        hasNext: true,
      },
    });
    const result4 = await iterator.next();
    expectJSON(result4).toDeepEqual({
      done: true,
      value: undefined,
    });
    await returnPromise;
  });
  it('Can return async iterable when underlying iterable does not have a return method', async () => {
    const document = parse(`
      query { 
        asyncIterableListNoReturn @stream(initialCount: 1) {
          name
          id
        }
      }
    `);
    const schema = new GraphQLSchema({ query });

    const executeResult = await execute({ schema, document, rootValue: {} });
    assert(isAsyncIterable(executeResult));
    const iterator = executeResult[Symbol.asyncIterator]();

    const result1 = await iterator.next();
    expectJSON(result1).toDeepEqual({
      done: false,
      value: {
        data: {
          asyncIterableListNoReturn: [
            {
              id: '1',
              name: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
    });

    const returnPromise = iterator.return();

    // this result had started processing before return was called
    const result2 = await iterator.next();
    expectJSON(result2).toDeepEqual({
      done: false,
      value: {
        incremental: [
          {
            items: [
              {
                id: '2',
                name: 'Han',
              },
            ],
            path: ['asyncIterableListNoReturn', 1],
          },
        ],
        hasNext: true,
      },
    });

    // third result is not returned because async iterator has returned
    const result3 = await iterator.next();
    expectJSON(result3).toDeepEqual({
      done: true,
      value: undefined,
    });
    await returnPromise;
  });
  it('Returns underlying async iterables when returned generator is thrown', async () => {
    const document = parse(`
      query { 
        asyncIterableListDelayed @stream(initialCount: 1) {
          ... @defer {
            name
          }
          id
        }
      }
    `);
    const schema = new GraphQLSchema({ query });

    const executeResult = await execute({ schema, document, rootValue: {} });
    assert(isAsyncIterable(executeResult));
    const iterator = executeResult[Symbol.asyncIterator]();

    const result1 = await iterator.next();
    expectJSON(result1).toDeepEqual({
      done: false,
      value: {
        data: {
          asyncIterableListDelayed: [
            {
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
    });

    const throwPromise = iterator.throw(new Error('bad'));

    // these results had started processing before return was called
    const result2 = await iterator.next();
    expectJSON(result2).toDeepEqual({
      done: false,
      value: {
        incremental: [
          {
            data: {
              name: 'Luke',
            },
            path: ['asyncIterableListDelayed', 0],
          },
        ],
        hasNext: true,
      },
    });
    const result3 = await iterator.next();
    expectJSON(result3).toDeepEqual({
      done: false,
      value: {
        incremental: [
          {
            items: [
              {
                id: '2',
              },
            ],
            path: ['asyncIterableListDelayed', 1],
          },
        ],
        hasNext: true,
      },
    });

    // this result is not returned because async iterator has returned
    const result4 = await iterator.next();
    expectJSON(result4).toDeepEqual({
      done: true,
      value: undefined,
    });
    try {
      await throwPromise; /* c8 ignore start */
      // Not reachable, always throws
      /* c8 ignore stop */
    } catch (e) {
      // ignore error
    }
  });
});