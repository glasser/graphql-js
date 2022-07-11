import { expect } from 'chai';
import { describe, it } from 'mocha';

import { flattenAsyncIterable } from '../flattenAsyncIterable';

describe('flattenAsyncIterable', () => {
  it('does not modify an already flat async generator', async () => {
    async function* source() {
      yield await Promise.resolve(1);
      yield await Promise.resolve(2);
      yield await Promise.resolve(3);
    }

    const result = flattenAsyncIterable(source());

    expect(await result.next()).to.deep.equal({ value: 1, done: false });
    expect(await result.next()).to.deep.equal({ value: 2, done: false });
    expect(await result.next()).to.deep.equal({ value: 3, done: false });
    expect(await result.next()).to.deep.equal({
      value: undefined,
      done: true,
    });
  });

  it('does not modify an already flat async iterator', async () => {
    const items = [1, 2, 3];

    const iterator: any = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return Promise.resolve({
          done: items.length === 0,
          value: items.shift(),
        });
      },
    };

    const result = flattenAsyncIterable(iterator);

    expect(await result.next()).to.deep.equal({ value: 1, done: false });
    expect(await result.next()).to.deep.equal({ value: 2, done: false });
    expect(await result.next()).to.deep.equal({ value: 3, done: false });
    expect(await result.next()).to.deep.equal({
      value: undefined,
      done: true,
    });
  });

  it('flatten nested async generators', async () => {
    async function* source() {
      yield await Promise.resolve(1);
      yield await Promise.resolve(2);
      yield await Promise.resolve(
        (async function* nested(): AsyncGenerator<number, void, void> {
          yield await Promise.resolve(2.1);
          yield await Promise.resolve(2.2);
        })(),
      );
      yield await Promise.resolve(3);
    }

    const doubles = flattenAsyncIterable(source());

    const result = [];
    for await (const x of doubles) {
      result.push(x);
    }
    expect(result).to.deep.equal([1, 2, 2.1, 2.2, 3]);
  });

  it('allows returning early from a nested async generator', async () => {
    async function* source() {
      yield await Promise.resolve(1);
      yield await Promise.resolve(2);
      yield await Promise.resolve(
        (async function* nested(): AsyncGenerator<number, void, void> {
          yield await Promise.resolve(2.1); /* c8 ignore start */
          // Not reachable, early return
          yield await Promise.resolve(2.2);
        })(),
      );
      // Not reachable, early return
      yield await Promise.resolve(3);
    }
    /* c8 ignore stop */

    const doubles = flattenAsyncIterable(source());

    expect(await doubles.next()).to.deep.equal({ value: 1, done: false });
    expect(await doubles.next()).to.deep.equal({ value: 2, done: false });
    expect(await doubles.next()).to.deep.equal({ value: 2.1, done: false });

    // Early return
    expect(await doubles.return()).to.deep.equal({
      value: undefined,
      done: true,
    });

    // Subsequent next calls
    expect(await doubles.next()).to.deep.equal({
      value: undefined,
      done: true,
    });
    expect(await doubles.next()).to.deep.equal({
      value: undefined,
      done: true,
    });
  });

  it('allows throwing errors from a nested async generator', async () => {
    async function* source() {
      yield await Promise.resolve(1);
      yield await Promise.resolve(2);
      yield await Promise.resolve(
        (async function* nested(): AsyncGenerator<number, void, void> {
          yield await Promise.resolve(2.1); /* c8 ignore start */
          // Not reachable, early return
          yield await Promise.resolve(2.2);
        })(),
      );
      // Not reachable, early return
      yield await Promise.resolve(3);
    }
    /* c8 ignore stop */

    const doubles = flattenAsyncIterable(source());

    expect(await doubles.next()).to.deep.equal({ value: 1, done: false });
    expect(await doubles.next()).to.deep.equal({ value: 2, done: false });
    expect(await doubles.next()).to.deep.equal({ value: 2.1, done: false });

    // Throw error
    let caughtError;
    try {
      await doubles.throw('ouch'); /* c8 ignore start */
      // Not reachable, always throws
      /* c8 ignore stop */
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError).to.equal('ouch');
  });
  /* c8 ignore start */
  it.skip('completely yields sub-iterables even when next() called in parallel', async () => {
    async function* source() {
      yield await Promise.resolve(
        (async function* nested(): AsyncGenerator<number, void, void> {
          yield await Promise.resolve(1.1);
          yield await Promise.resolve(1.2);
        })(),
      );
      yield await Promise.resolve(2);
    }

    const result = flattenAsyncIterable(source());

    const promise1 = result.next();
    const promise2 = result.next();
    expect(await promise1).to.deep.equal({ value: 1.1, done: false });
    expect(await promise2).to.deep.equal({ value: 1.2, done: false });
    expect(await result.next()).to.deep.equal({ value: 2, done: false });
    expect(await result.next()).to.deep.equal({
      value: undefined,
      done: true,
    });
  });
  /* c8 ignore stop */
});