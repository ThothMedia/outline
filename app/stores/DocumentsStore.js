// @flow
import { observable, action, computed, runInAction } from 'mobx';
import { without, map, find, orderBy, filter, compact, uniq } from 'lodash';
import { client } from 'utils/ApiClient';
import naturalSort from 'shared/utils/naturalSort';
import invariant from 'invariant';

import BaseStore from 'stores/BaseStore';
import RootStore from 'stores/RootStore';
import Document from '../models/Document';
import Revision from '../models/Revision';
import type { FetchOptions, PaginationParams, SearchResult } from 'types';

export default class DocumentsStore extends BaseStore<Document> {
  @observable recentlyViewedIds: string[] = [];
  @observable searchCache: Map<string, SearchResult[]> = new Map();

  constructor(rootStore: RootStore) {
    super(rootStore, Document);
  }

  @computed
  get recentlyViewed(): * {
    return orderBy(
      compact(this.recentlyViewedIds.map(id => this.data.get(id))),
      'updatedAt',
      'desc'
    );
  }

  @computed
  get recentlyUpdated(): * {
    return orderBy(Array.from(this.data.values()), 'updatedAt', 'desc');
  }

  createdByUser(userId: string): * {
    return orderBy(
      filter(
        Array.from(this.data.values()),
        document => document.createdBy.id === userId
      ),
      'updatedAt',
      'desc'
    );
  }

  pinnedInCollection(collectionId: string): Document[] {
    return filter(
      this.recentlyUpdatedInCollection(collectionId),
      document => document.pinned
    );
  }

  publishedInCollection(collectionId: string): Document[] {
    return filter(
      Array.from(this.data.values()),
      document =>
        document.collectionId === collectionId && !!document.publishedAt
    );
  }

  leastRecentlyUpdatedInCollection(collectionId: string): Document[] {
    return orderBy(
      this.publishedInCollection(collectionId),
      'updatedAt',
      'asc'
    );
  }

  recentlyUpdatedInCollection(collectionId: string): Document[] {
    return orderBy(
      this.publishedInCollection(collectionId),
      'updatedAt',
      'desc'
    );
  }

  recentlyPublishedInCollection(collectionId: string): Document[] {
    return orderBy(
      this.publishedInCollection(collectionId),
      'publishedAt',
      'desc'
    );
  }

  alphabeticalInCollection(collectionId: string): Document[] {
    return naturalSort(this.publishedInCollection(collectionId), 'title');
  }

  searchResults(query: string): SearchResult[] {
    return this.searchCache.get(query) || [];
  }

  @computed
  get starred(): Document[] {
    return filter(this.orderedData, d => d.starred);
  }

  @computed
  get starredAlphabetical(): Document[] {
    return naturalSort(this.starred, 'title');
  }

  @computed
  get drafts(): Document[] {
    return filter(
      orderBy(Array.from(this.data.values()), 'updatedAt', 'desc'),
      doc => !doc.publishedAt
    );
  }

  @computed
  get active(): ?Document {
    return this.rootStore.ui.activeDocumentId
      ? this.data.get(this.rootStore.ui.activeDocumentId)
      : undefined;
  }

  @action
  fetchNamedPage = async (
    request: string = 'list',
    options: ?PaginationParams
  ): Promise<?(Document[])> => {
    this.isFetching = true;

    try {
      const res = await client.post(`/documents.${request}`, options);
      invariant(res && res.data, 'Document list not available');
      const { data } = res;
      runInAction('DocumentsStore#fetchNamedPage', () => {
        data.forEach(this.add);
        this.isLoaded = true;
      });
      return data;
    } finally {
      this.isFetching = false;
    }
  };

  @action
  fetchRecentlyUpdated = async (options: ?PaginationParams): Promise<*> => {
    return this.fetchNamedPage('list', options);
  };

  @action
  fetchAlphabetical = async (options: ?PaginationParams): Promise<*> => {
    return this.fetchNamedPage('list', {
      sort: 'title',
      direction: 'ASC',
      ...options,
    });
  };

  @action
  fetchLeastRecentlyUpdated = async (
    options: ?PaginationParams
  ): Promise<*> => {
    return this.fetchNamedPage('list', {
      sort: 'updatedAt',
      direction: 'ASC',
      ...options,
    });
  };

  @action
  fetchRecentlyPublished = async (options: ?PaginationParams): Promise<*> => {
    return this.fetchNamedPage('list', {
      sort: 'publishedAt',
      direction: 'DESC',
      ...options,
    });
  };

  @action
  fetchRecentlyViewed = async (options: ?PaginationParams): Promise<*> => {
    const data = await this.fetchNamedPage('viewed', options);

    runInAction('DocumentsStore#fetchRecentlyViewed', () => {
      // $FlowFixMe
      this.recentlyViewedIds.replace(
        uniq(this.recentlyViewedIds.concat(map(data, 'id')))
      );
    });
    return data;
  };

  @action
  fetchStarred = (options: ?PaginationParams): Promise<*> => {
    return this.fetchNamedPage('starred', options);
  };

  @action
  fetchDrafts = (options: ?PaginationParams): Promise<*> => {
    return this.fetchNamedPage('drafts', options);
  };

  @action
  fetchPinned = (options: ?PaginationParams): Promise<*> => {
    return this.fetchNamedPage('pinned', options);
  };

  @action
  fetchOwned = (options: ?PaginationParams): Promise<*> => {
    return this.fetchNamedPage('list', options);
  };

  @action
  search = async (
    query: string,
    options: PaginationParams = {}
  ): Promise<SearchResult[]> => {
    const res = await client.get('/documents.search', {
      ...options,
      query,
    });
    invariant(res && res.data, 'Search response should be available');
    const { data } = res;

    // add the document to the store
    data.forEach(result => this.add(result.document));

    // store a reference to the document model in the search cache instead
    // of the original result from the API.
    const results: SearchResult[] = compact(
      data.map(result => {
        const document = this.data.get(result.document.id);
        if (!document) return null;

        return {
          ranking: result.ranking,
          context: result.context,
          document,
        };
      })
    );

    let existing = this.searchCache.get(query) || [];

    // splice modifies any existing results, taking into account pagination
    existing.splice(options.offset || 0, options.limit || 0, ...results);

    this.searchCache.set(query, existing);
    return data;
  };

  @action
  prefetchDocument = (id: string) => {
    if (!this.data.get(id)) {
      return this.fetch(id, { prefetch: true });
    }
  };

  @action
  fetch = async (
    id: string,
    options?: FetchOptions = {}
  ): Promise<?Document> => {
    if (!options.prefetch) this.isFetching = true;

    try {
      const doc: ?Document = this.data.get(id) || this.getByUrl(id);
      if (doc) return doc;

      const res = await client.post('/documents.info', {
        id,
        shareId: options.shareId,
      });
      invariant(res && res.data, 'Document not available');
      this.add(res.data);

      runInAction('DocumentsStore#fetch', () => {
        this.isLoaded = true;
      });

      return this.data.get(res.data.id);
    } finally {
      this.isFetching = false;
    }
  };

  @action
  move = async (document: Document, parentDocumentId: ?string) => {
    const res = await client.post('/documents.move', {
      id: document.id,
      parentDocument: parentDocumentId,
    });
    invariant(res && res.data, 'Data not available');

    const collection = this.getCollectionForDocument(document);
    if (collection) collection.refresh();

    return this.add(res.data);
  };

  @action
  duplicate = async (document: Document): * => {
    const res = await client.post('/documents.create', {
      publish: true,
      parentDocument: document.parentDocumentId,
      collection: document.collection.id,
      title: `${document.title} (duplicate)`,
      text: document.text,
    });
    invariant(res && res.data, 'Data should be available');

    const collection = this.getCollectionForDocument(document);
    if (collection) collection.refresh();

    return this.add(res.data);
  };

  async update(params: *) {
    const document = await super.update(params);

    // Because the collection object contains the url and title
    // we need to ensure they are updated there as well.
    const collection = this.getCollectionForDocument(document);
    if (collection) collection.updateDocument(document);
    return document;
  }

  async delete(document: Document) {
    await super.delete(document);

    runInAction(() => {
      this.recentlyViewedIds = without(this.recentlyViewedIds, document.id);
    });

    const collection = this.getCollectionForDocument(document);
    if (collection) collection.refresh();
  }

  @action
  restore = async (document: Document, revision: Revision) => {
    const res = await client.post('/documents.restore', {
      id: document.id,
      revisionId: revision.id,
    });
    runInAction('Document#restore', () => {
      invariant(res && res.data, 'Data should be available');
      document.updateFromJson(res.data);
    });
  };

  pin = (document: Document) => {
    return client.post('/documents.pin', { id: document.id });
  };

  unpin = (document: Document) => {
    return client.post('/documents.unpin', { id: document.id });
  };

  star = (document: Document) => {
    return client.post('/documents.star', { id: document.id });
  };

  unstar = (document: Document) => {
    return client.post('/documents.unstar', { id: document.id });
  };

  getByUrl = (url: string = ''): ?Document => {
    return find(Array.from(this.data.values()), doc => url.endsWith(doc.urlId));
  };

  getCollectionForDocument(document: Document) {
    return this.rootStore.collections.data.get(document.collectionId);
  }
}
