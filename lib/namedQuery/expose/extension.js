import NamedQuery from '../namedQuery.js';
import { ExposeSchema, ExposeDefaults } from './schema.js';
import mergeDeep from './lib/mergeDeep.js';
import createGraph from '../../query/lib/createGraph.js';
import recursiveCompose from '../../query/lib/recursiveCompose.js';
import prepareForProcess from '../../query/lib/prepareForProcess.js';
import deepClone from 'lodash.clonedeep';
import intersectDeep from '../../query/lib/intersectDeep';
import genCountEndpoint from '../../query/counts/genEndpoint.server';
import { check } from 'meteor/check';
import { _ } from 'meteor/underscore';

_.extend(NamedQuery.prototype, {
  /**
   * @this {typeof NamedQuery}
   * @param {Grapher.ExposureConfig} [config]
   */
  expose(config = {}) {
    if (!Meteor.isServer) {
      throw new Meteor.Error(
        'invalid-environment',
        `You must run this in server-side code`,
      );
    }

    if (this.isExposed) {
      throw new Meteor.Error(
        'query-already-exposed',
        `You have already exposed: "${this.name}" named query`,
      );
    }

    this.exposeConfig = Object.assign({}, ExposeDefaults, config);
    check(this.exposeConfig, ExposeSchema);

    if (this.exposeConfig.validateParams) {
      this.options.validateParams = this.exposeConfig.validateParams;
    }

    if (!this.isResolver) {
      this._initNormalQuery();
    } else {
      this._initMethod();
    }

    this.isExposed = true;
  },

  /**
   * Initializes a normal NamedQuery (normal == not a resolver)
   * @private
   */
  _initNormalQuery() {
    const config = this.exposeConfig;
    if (config.method) {
      this._initMethod();
    }

    if (config.publication) {
      this._initPublication();
    }

    if (!config.method && !config.publication) {
      throw new Meteor.Error(
        'weird',
        'If you want to expose your named query you need to specify at least one of ["method", "publication"] options to true',
      );
    }

    this._initCountMethod();
    this._initCountPublication();
  },

  /**
   * Returns the embodied body of the request
   * @param {*} _embody
   * @param {*} body
   */
  doEmbodimentIfItApplies(body, params) {
    // query is not exposed yet, so it doesn't have embodiment logic
    if (!this.exposeConfig) {
      return;
    }

    const { embody } = this.exposeConfig;

    if (!embody) {
      return;
    }

    if (_.isFunction(embody)) {
      embody.call(this, body, params);
    } else {
      mergeDeep(body, embody);
    }
  },

  /**
   * @private
   */
  _initMethod() {
    const self = this;
    Meteor.methods({
      [this.name](newParams) {
        self._unblockIfNecessary(this);

        // security is done in the fetching because we provide a context
        return self.clone(newParams).fetchAsync(this);
      },
    });
  },

  /**
   * @returns {void}
   * @private
   */
  _initCountMethod() {
    const self = this;

    Meteor.methods({
      [this.name + '.count'](newParams) {
        self._unblockIfNecessary(this);

        // security is done in the fetching because we provide a context
        return self.clone(newParams).getCountAsync(this);
      },
    });
  },

  /**
   * @returns {*}
   * @private
   */
  _initCountPublication() {
    const self = this;

    genCountEndpoint(self.name, {
      getCursor({ session }) {
        const query = self.clone(session.params);
        return query.getCursorForCounting();
      },

      async getSession(params) {
        self.doValidateParams(params);
        await self._callFirewall(this, this.userId, params);

        return { name: self.name, params };
      },
    });
  },

  /**
   * @private
   */
  _initPublication() {
    const self = this;

    Meteor.publishComposite(this.name, async function (params = {}) {
      const isScoped = !!self.options.scoped;

      if (isScoped) {
        this.enableScope();
      }

      self._unblockIfNecessary(this);
      await self.doValidateParams(params);
      await self._callFirewall(this, this.userId, params);

      let body = deepClone(self.body);
      if (params.$body) {
        body = intersectDeep(body, params.$body);
      }

      self.doEmbodimentIfItApplies(body, params);
      body = prepareForProcess(body, params);

      const rootNode = createGraph(self.collection, body);

      return recursiveCompose(rootNode, undefined, {
        scoped: isScoped,
        blocking: self.exposeConfig.blocking,
      });
    });
  },

  /**
   * @param context
   * @param userId
   * @param params
   * @private
   */
  async _callFirewall(context, userId, params) {
    const { firewall } = this.exposeConfig;
    if (!firewall) {
      return;
    }

    if (Array.isArray(firewall)) {
      for (const f of firewall) {
        await f.call(context, userId, params);
      }
    } else {
      await firewall.call(context, userId, params);
    }
  },

  /**
   * @param context
   * @private
   */
  _unblockIfNecessary(context) {
    if (this.exposeConfig.unblock) {
      if (context.unblock) {
        context.unblock();
      }
    }
  },
});
