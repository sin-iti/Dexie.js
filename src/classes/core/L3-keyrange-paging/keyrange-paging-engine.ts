import { VirtualIndexCore } from '../L2-virtual-indexes';
import { QueryBase, Transaction, KeyRange, Cursor, Key, GetAllQuery, OpenCursorQuery } from '../L1-dbcore/dbcore';
import { OffsetCursor } from '../L1-dbcore/utils/offset-cursor';
import { exceptions } from '../../../errors';
import { assert, isArray } from '../../../functions/utils';
import { stringifyKey, unstringifyKey } from '../../../functions/stringify-key';
import { KeyRangePageToken } from './pagetoken';

export interface KeyRangePagingCore extends VirtualIndexCore {
  queryRange(query: PagableKeyRangeQuery): Promise<QueryRangeResponse>;
}

export interface PagableQueryBase extends QueryBase {
  values?: boolean;
  limit?: number;
  unique?: boolean;
  reverse?: boolean;
  wantPageToken?: boolean;
  pageToken?: KeyRangePageToken;  
}

export interface PagableKeyRangeQuery extends PagableQueryBase, OpenCursorQuery, GetAllQuery {
  range?: KeyRange;
  values?: boolean;
  limit?: number;
  unique?: boolean;
  reverse?: boolean;
  wantPageToken?: boolean;
  pageToken?: KeyRangePageToken;
}

export interface QueryRangeResponse {
  pageToken?: KeyRangePageToken;
  result: any[];
  partial?: boolean; // True if the requested limit was not reached. If so, pageToken will be present, no matter wantPageToken or not.
}

export function KeyRangePagingEngine(next: VirtualIndexCore): KeyRangePagingCore {
  return {
    ...next,
    queryRange,
    openCursor(query) {
      return null;
    }
  };

  function openCursor (query: PagableKeyRangeQuery): Promise<Cursor> {
    const {pageToken, range, values, reverse} = query;

    // Translate query from PagableKeyRangeQuery to OpenCursorQuery.
    // The only missing property is "values" that should be true IFF want === 'value':
    if (!pageToken) {
      // We don't have a pageToken. Call openCursor():
      return next.openCursor(query);
    }

    if (pageToken.type !== 'lastKey') {
      return pageToken.type === 'cursor' ?
        Promise.resolve(pageToken.cursor) :
        next.openCursor(query).then(cursor => OffsetCursor(cursor, pageToken.offset));
    }

    // We have a pageToken of type "lastKey".
    // This can happen if we need to use openCursor() even though caller did not
    // provide a cursor. We need to openCursor() and then forward it to the position
    // after given lastKey/lastPrimaryKey:

    // Adjust range:
    query = {...query, range: reverse ?
      {...range, upper: pageToken.lastKey, upperOpen: false} :
      {...range, lower: pageToken.lastKey, lowerOpen: false}};

    const cursorPromise = next.openCursor(query);
    
    return pageToken.lastPrimaryKey == null ?
      cursorPromise :
      cursorPromise.then(cursor => cursor && Object.create(cursor, {
        start: {
          value: (onNext) =>
            cursor.start(()=>cursor.stop(), pageToken.lastKey, pageToken.lastPrimaryKey)
              .then(()=>cursor.start(onNext))
        }
      }));
  }
    
  function queryRange(query: PagableKeyRangeQuery): Promise<QueryRangeResponse> {
    let { table, index, pageToken, range, reverse, wantPageToken, limit, unique, values } = query;
    const idx = next.tableIndexLookup[table][index][0];

    let useCursor = (
      (pageToken && pageToken.type !== 'lastKey' ) || // There's already a cursor to continue from
      reverse || // reverse calls
      unique ||
      idx.keyLength === 0 || // outbound primary key. Cant find the index after getAll() or getAllKeys()
      (limit < 10 && !values && !idx.index.isPrimaryKey) // When using getAllKeys(), low limit may not be so good since pageToken will need to query last value unless we're iterating primary key
    );

    if (limit === 0) return wantPageToken ?
      openCursor(query).then(cursor => ({
        result: [],
        pageToken: new KeyRangePageToken({type: 'cursor', cursor})
      })) :
      Promise.resolve({result: []});

    if (useCursor) {
      //
      // openCursor()
      //
      const result: any[] = [];
      return openCursor(query).then(cursor => !cursor ?
        // Empty result:
        {result} : 
        // At least one entry in result. Iterate cursor:
        cursor.start(() => {
          result.push(values ? cursor.value : cursor.primaryKey);
          if (result.length === limit) {
            return cursor.stop(true);// stop(true): Will resolve promise with `true`
          }
          cursor.continue(); // DBCore will call cursor.stop(undefined) if end is reached.
        }).then(limitReached => limitReached && wantPageToken ?
          { result, pageToken: new KeyRangePageToken({ type: 'cursor' as 'cursor', cursor }) } :
          { result })); // Entire result done, or wantPageToken is false. Not partial!
    }

    //
    // use getAll()
    //

    // Manipulate range according to lastKey
    if (pageToken) {
      const {lastKey, lastPrimaryKey} = pageToken;
      if (lastPrimaryKey != null) {
        //
        // Must use openCursor with continuePrimaryKey() to iterate the remainding entries
        // on this key that has same key but different primary keys:
        //
        const result = [];
        return openCursor(query)
          .then(cursor => !cursor ?
            {result} : // End of query
            cursor.start(() => {
              if (next.cmp(cursor.key, lastKey) > 0) {
                return cursor.stop({passed: true}); // Makes promise resolve with 'passed'.
              }
              result.push(values ? cursor.value : cursor.primaryKey);
              if (result.length < limit) {
                return cursor.continue();
              }
              cursor.stop({lastPrimaryKey: cursor.primaryKey}); // Makes promise resolve with the primaryKey we're on.
            }).then(res => {
              // res will be undefined if cursor came to the final end.
              // ==> Return result without pageToken
              if (!res) return {result}; // Complete response.

              // res will be {passed: true} if cursor's key passed beyond lastKey.
              // ==> next query() will use getAll()
              if (res.passed) return {
                result,
                partial: true,
                pageToken: new KeyRangePageToken({type: 'lastKey' as 'lastKey', lastKey}) // Always send pageToken on partial results
              };

              // Else, lastPrimaryKey will be last cursor's primaryKey
              // ==> next query() will come here again and do openCursor()
              return wantPageToken ? {
                result,
                pageToken: new KeyRangePageToken({
                  type: 'lastKey' as 'lastKey',
                  lastKey,
                  lastPrimaryKey: res.primaryKey
                })
              } : {result}; // Caller not interested in pageToken.
            }));
      } else {
        // We can do getAll() but we have a pageToken to consider:
        query = {
          ...query,
          range: {
            ...range,
            lower: lastKey,
            lowerOpen: true // Don't include last key
          }
        };
      }
    }
  
    return next.getAll(query).then(result => {
      if (result.length < limit) {
        // We did not reach limit.
        // Return response with no pageToken set.
        return {result};
      }
      // Limit reached. There's probably more entries to query (could also be that the length of result is equal to given limit)
      if ((idx.index.multiEntry) || // multiEntry index
        (values && idx.keyLength === 0)) // outbound primary key, and caller needs values.
      {
        // multiEntry or outbound primary keys. Impossible to follow up next iteration after getAll()
        // Set an OffsetCursor as {cursor} in pageToken, so that next query will go into the 'useCursor'
        // part and forward the cursor using Cursor.advance(this limit).
        // This will do an extra call to openCursor(), but it won't do cursor.advance() until
        // they really do the next query, as OffsetCursor is lazy.
        return (!wantPageToken ?
          { result } : // Caller does not want pageToken.
          {
            result,
            pageToken: new KeyRangePageToken({
              type: 'offset',
              offset: limit
            })
          });
      }

      // If caller is not interested in pageToken, we're done now:
      if (!wantPageToken) return { result };

      // We can look up next key.
      const lastEntry = result[limit - 1]; // primaryKey or value
      if (values) {
        // lastEntry is a value.
        // Create a page token containing lastKey and lastPrimaryKey
        // by extracting primaryKey from value
        const primaryKeyIdx = next.tableIndexLookup[table][":id"][0];
        return {
          result,
          pageToken: new KeyRangePageToken({
            type: 'lastKey',
            lastKey: idx.extractKey(lastEntry),
            lastPrimaryKey: idx.index.unique ?
              null : // No need to record lastPrimaryKey if index is unique (including primary key). Safe to do getAll() on rest.
              primaryKeyIdx.extractKey(lastEntry)
          })
        };
      } else if (idx.index.isPrimaryKey) {
        // We're iterating the primary key, so we will never need to record lastPrimaryKey,
        // as it will be equal to lastKey and safe for getAllKeys() again.
        return {
          result,
          pageToken: new KeyRangePageToken({
            type: 'lastKey',
            lastKey: lastEntry
          })
        };
      } else {
        // lastItem is a primaryKey.
        // Create a page token containing lastKey and lastPrimaryKey
        // by loading value from key, and then extract the key
        return next.get({ trans: query.trans, table, keys: [lastEntry] }).then(([value]) => ({
          result,
          pageToken: new KeyRangePageToken({
            type: 'lastKey',
            lastKey: lastEntry,
            lastPrimaryKey: idx.extractKey(value)
          })
        } as QueryRangeResponse));
      }
    });
  }
}