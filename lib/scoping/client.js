import { LocalCollection } from 'meteor/minimongo';

const Connection = Meteor.connection.constructor;

const originalSubscribe = Connection.prototype.subscribe;
Connection.prototype.subscribe = function (...args) {
  const handle = originalSubscribe.apply(this, args);

  handle.scopeQuery = function () {
    const query = {};
    query[`_sub_${handle.subscriptionId}`] = {
      $exists: true,
    };
    return query;
  };

  return handle;
};

// Recreate the convenience method.
Meteor.subscribe = Meteor.connection.subscribe.bind(Meteor.connection);

const originalCompileProjection = LocalCollection._compileProjection;
LocalCollection._compileProjection = function (fields) {
  const fun = originalCompileProjection(fields);

  return function (obj) {
    const res = fun(obj);

    for (const field of Object.keys(res)) {
      if (field.lastIndexOf('_sub_', 0) === 0) {
        delete res[field];
      }
    }

    return res;
  };
};
