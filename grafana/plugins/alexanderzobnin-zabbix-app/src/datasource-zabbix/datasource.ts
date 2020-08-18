import _ from 'lodash';
import config from 'grafana/app/core/config';
import { contextSrv } from 'grafana/app/core/core';
import * as dateMath from 'grafana/app/core/utils/datemath';
import * as utils from './utils';
import * as migrations from './migrations';
import * as metricFunctions from './metricFunctions';
import * as c from './constants';
import dataProcessor from './dataProcessor';
import responseHandler from './responseHandler';
import problemsHandler from './problemsHandler';
import { Zabbix } from './zabbix/zabbix';
import { ZabbixAPIError } from './zabbix/connectors/zabbix_api/zabbixAPICore';
import { VariableQueryTypes, ShowProblemTypes } from './types';

export class ZabbixDatasource {
  name: string;
  url: string;
  basicAuth: any;
  withCredentials: any;

  username: string;
  password: string;
  trends: boolean;
  trendsFrom: string;
  trendsRange: string;
  cacheTTL: any;
  alertingEnabled: boolean;
  addThresholds: boolean;
  alertingMinSeverity: string;
  disableReadOnlyUsersAck: boolean;
  enableDirectDBConnection: boolean;
  dbConnectionDatasourceId: number;
  dbConnectionDatasourceName: string;
  dbConnectionRetentionPolicy: string;
  enableDebugLog: boolean;
  zabbix: Zabbix;

  replaceTemplateVars: (target: any, scopedVars?: any) => any;

  /** @ngInject */
  constructor(instanceSettings, private templateSrv, private zabbixAlertingSrv) {
    this.templateSrv = templateSrv;
    this.zabbixAlertingSrv = zabbixAlertingSrv;

    this.enableDebugLog = config.buildInfo.env === 'development';

    // Use custom format for template variables
    this.replaceTemplateVars = _.partial(replaceTemplateVars, this.templateSrv);

    // General data source settings
    this.name             = instanceSettings.name;
    this.url              = instanceSettings.url;
    this.basicAuth        = instanceSettings.basicAuth;
    this.withCredentials  = instanceSettings.withCredentials;

    const jsonData = migrations.migrateDSConfig(instanceSettings.jsonData);

    // Zabbix API credentials
    this.username         = jsonData.username;
    this.password         = jsonData.password;

    // Use trends instead history since specified time
    this.trends           = jsonData.trends;
    this.trendsFrom       = jsonData.trendsFrom || '7d';
    this.trendsRange      = jsonData.trendsRange || '4d';

    // Set cache update interval
    const ttl = jsonData.cacheTTL || '1h';
    this.cacheTTL = utils.parseInterval(ttl);

    // Alerting options
    this.alertingEnabled =     jsonData.alerting;
    this.addThresholds =       jsonData.addThresholds;
    this.alertingMinSeverity = jsonData.alertingMinSeverity || c.SEV_WARNING;

    // Other options
    this.disableReadOnlyUsersAck = jsonData.disableReadOnlyUsersAck;

    // Direct DB Connection options
    this.enableDirectDBConnection = jsonData.dbConnectionEnable || false;
    this.dbConnectionDatasourceId = jsonData.dbConnectionDatasourceId;
    this.dbConnectionDatasourceName = jsonData.dbConnectionDatasourceName;
    this.dbConnectionRetentionPolicy = jsonData.dbConnectionRetentionPolicy;

    const zabbixOptions = {
      url: this.url,
      username: this.username,
      password: this.password,
      basicAuth: this.basicAuth,
      withCredentials: this.withCredentials,
      cacheTTL: this.cacheTTL,
      enableDirectDBConnection: this.enableDirectDBConnection,
      dbConnectionDatasourceId: this.dbConnectionDatasourceId,
      dbConnectionDatasourceName: this.dbConnectionDatasourceName,
      dbConnectionRetentionPolicy: this.dbConnectionRetentionPolicy,
    };

    this.zabbix = new Zabbix(zabbixOptions);
  }

  ////////////////////////
  // Datasource methods //
  ////////////////////////

  /**
   * Query panel data. Calls for each panel in dashboard.
   * @param  {Object} options   Contains time range, targets and other info.
   * @return {Object} Grafana metrics object with timeseries data for each target.
   */
  query(options) {
    // Get alerts for current panel
    if (this.alertingEnabled) {
      this.alertQuery(options).then(alert => {
        this.zabbixAlertingSrv.setPanelAlertState(options.panelId, alert.state);

        this.zabbixAlertingSrv.removeZabbixThreshold(options.panelId);
        if (this.addThresholds) {
          _.forEach(alert.thresholds, threshold => {
            this.zabbixAlertingSrv.setPanelThreshold(options.panelId, threshold);
          });
        }
      });
    }

    // Create request for each target
    const promises = _.map(options.targets, t => {
      // Don't request for hidden targets
      if (t.hide) {
        return [];
      }

      let timeFrom = Math.ceil(dateMath.parse(options.range.from) / 1000);
      let timeTo = Math.ceil(dateMath.parse(options.range.to) / 1000);

      // Add range variables
      options.scopedVars = Object.assign({}, options.scopedVars, utils.getRangeScopedVars(options.range));

      // Prevent changes of original object
      let target = _.cloneDeep(t);

      // Migrate old targets
      target = migrations.migrate(target);
      this.replaceTargetVariables(target, options);

      // Apply Time-related functions (timeShift(), etc)
      const timeFunctions = bindFunctionDefs(target.functions, 'Time');
      if (timeFunctions.length) {
        const [time_from, time_to] = utils.sequence(timeFunctions)([timeFrom, timeTo]);
        timeFrom = time_from;
        timeTo = time_to;
      }
      const timeRange = [timeFrom, timeTo];

      const useTrends = this.isUseTrends(timeRange);

      // Metrics or Text query
      if (!target.queryType || target.queryType === c.MODE_METRICS || target.queryType === c.MODE_TEXT) {
        // Don't request undefined targets
        if (!target.group || !target.host || !target.item) {
          return [];
        }

        if (!target.queryType || target.queryType === c.MODE_METRICS) {
          return this.queryNumericData(target, timeRange, useTrends, options);
        } else if (target.queryType === c.MODE_TEXT) {
          return this.queryTextData(target, timeRange);
        } else {
          return [];
        }
      } else if (target.queryType === c.MODE_ITEMID) {
        // Item ID query
        if (!target.itemids) {
          return [];
        }
        return this.queryItemIdData(target, timeRange, useTrends, options);
      } else if (target.queryType === c.MODE_ITSERVICE) {
        // IT services query
        return this.queryITServiceData(target, timeRange, options);
      } else if (target.queryType === c.MODE_TRIGGERS) {
        // Triggers query
        return this.queryTriggersData(target, timeRange);
      } else if (target.queryType === c.MODE_PROBLEMS) {
        // Problems query
        return this.queryProblems(target, timeRange, options);
      } else {
        return [];
      }
    });

    // Data for panel (all targets)
    return Promise.all(_.flatten(promises))
      .then(_.flatten)
      .then(data => {
        return { data: data };
      });
  }

  /**
   * Query target data for Metrics
   */
  queryNumericData(target, timeRange, useTrends, options) {
    let queryStart, queryEnd;
    const getItemOptions = {
      itemtype: 'num'
    };
    return this.zabbix.getItemsFromTarget(target, getItemOptions)
    .then(items => {
      queryStart = new Date().getTime();
      return this.queryNumericDataForItems(items, target, timeRange, useTrends, options);
    }).then(result => {
      queryEnd = new Date().getTime();
      if (this.enableDebugLog) {
        console.log(`Datasource::Performance Query Time (${this.name}): ${queryEnd - queryStart}`);
      }
      return result;
    });
  }

  /**
   * Query history for numeric items
   */
  queryNumericDataForItems(items, target, timeRange, useTrends, options) {
    let getHistoryPromise;
    options.valueType = this.getTrendValueType(target);
    options.consolidateBy = getConsolidateBy(target) || options.valueType;

    if (useTrends) {
      getHistoryPromise = this.zabbix.getTrends(items, timeRange, options);
    } else {
      getHistoryPromise = this.zabbix.getHistoryTS(items, timeRange, options);
    }

    return getHistoryPromise
    .then(timeseries => this.applyDataProcessingFunctions(timeseries, target))
    .then(timeseries => downsampleSeries(timeseries, options));
  }

  getTrendValueType(target) {
    // Find trendValue() function and get specified trend value
    const trendFunctions = _.map(metricFunctions.getCategories()['Trends'], 'name');
    const trendValueFunc = _.find(target.functions, func => {
      return _.includes(trendFunctions, func.def.name);
    });
    return trendValueFunc ? trendValueFunc.params[0] : "avg";
  }

  applyDataProcessingFunctions(timeseries_data, target) {
    const transformFunctions   = bindFunctionDefs(target.functions, 'Transform');
    const aggregationFunctions = bindFunctionDefs(target.functions, 'Aggregate');
    const filterFunctions      = bindFunctionDefs(target.functions, 'Filter');
    const aliasFunctions       = bindFunctionDefs(target.functions, 'Alias');

    // Apply transformation functions
    timeseries_data = _.cloneDeep(_.map(timeseries_data, timeseries => {
      timeseries.datapoints = utils.sequence(transformFunctions)(timeseries.datapoints);
      return timeseries;
    }));

    // Apply filter functions
    if (filterFunctions.length) {
      timeseries_data = utils.sequence(filterFunctions)(timeseries_data);
    }

    // Apply aggregations
    if (aggregationFunctions.length) {
      let dp = _.map(timeseries_data, 'datapoints');
      dp = utils.sequence(aggregationFunctions)(dp);

      const aggFuncNames = _.map(metricFunctions.getCategories()['Aggregate'], 'name');
      const lastAgg = _.findLast(target.functions, func => {
        return _.includes(aggFuncNames, func.def.name);
      });

      timeseries_data = [{
        target: lastAgg.text,
        datapoints: dp
      }];
    }

    // Apply alias functions
    _.forEach(timeseries_data, utils.sequence(aliasFunctions).bind(this));

    // Apply Time-related functions (timeShift(), etc)
    // Find timeShift() function and get specified trend value
    this.applyTimeShiftFunction(timeseries_data, target);

    return timeseries_data;
  }

  applyTimeShiftFunction(timeseries_data, target) {
    // Find timeShift() function and get specified interval
    const timeShiftFunc = _.find(target.functions, (func) => {
      return func.def.name === 'timeShift';
    });
    if (timeShiftFunc) {
      const shift = timeShiftFunc.params[0];
      _.forEach(timeseries_data, (series) => {
        series.datapoints = dataProcessor.unShiftTimeSeries(shift, series.datapoints);
      });
    }
  }

  /**
   * Query target data for Text
   */
  queryTextData(target, timeRange) {
    const options = {
      itemtype: 'text'
    };
    return this.zabbix.getItemsFromTarget(target, options)
    .then(items => {
      return this.zabbix.getHistoryText(items, timeRange, target);
    });
  }

  /**
   * Query target data for Item ID
   */
  queryItemIdData(target, timeRange, useTrends, options) {
    let itemids = target.itemids;
    itemids = this.templateSrv.replace(itemids, options.scopedVars, zabbixItemIdsTemplateFormat);
    itemids = _.map(itemids.split(','), itemid => itemid.trim());

    if (!itemids) {
      return [];
    }

    return this.zabbix.getItemsByIDs(itemids)
    .then(items => {
      return this.queryNumericDataForItems(items, target, timeRange, useTrends, options);
    });
  }

  /**
   * Query target data for IT Services
   */
  queryITServiceData(target, timeRange, options) {
    // Don't show undefined and hidden targets
    if (target.hide || (!target.itservice && !target.itServiceFilter) || !target.slaProperty) {
      return [];
    }

    let itServiceFilter;
    options.isOldVersion = target.itservice && !target.itServiceFilter;

    if (options.isOldVersion) {
      // Backward compatibility
      itServiceFilter = '/.*/';
    } else {
      itServiceFilter = this.replaceTemplateVars(target.itServiceFilter, options.scopedVars);
    }

    options.slaInterval = target.slaInterval;

    return this.zabbix.getITServices(itServiceFilter)
    .then(itservices => {
      if (options.isOldVersion) {
        itservices = _.filter(itservices, {'serviceid': target.itservice?.serviceid});
      }
      return this.zabbix.getSLA(itservices, timeRange, target, options);})
    .then(itservicesdp => this.applyDataProcessingFunctions(itservicesdp, target));
  }

  queryTriggersData(target, timeRange) {
    const [timeFrom, timeTo] = timeRange;
    return this.zabbix.getHostsFromTarget(target)
    .then(results => {
      const [hosts, apps] = results;
      if (hosts.length) {
        const hostids = _.map(hosts, 'hostid');
        const appids = _.map(apps, 'applicationid');
        const options = {
          minSeverity: target.triggers.minSeverity,
          acknowledged: target.triggers.acknowledged,
          count: target.triggers.count,
          timeFrom: timeFrom,
          timeTo: timeTo
        };
        const groupFilter = target.group.filter;
        return Promise.all([
          this.zabbix.getHostAlerts(hostids, appids, options),
          this.zabbix.getGroups(groupFilter)
        ])
        .then(([triggers, groups]) => {
          return responseHandler.handleTriggersResponse(triggers, groups, timeRange);
        });
      } else {
        return Promise.resolve([]);
      }
    });
  }

  queryProblems(target, timeRange, options) {
    const [timeFrom, timeTo] = timeRange;
    const userIsEditor = contextSrv.isEditor || contextSrv.isGrafanaAdmin;

    let proxies;
    let showAckButton = true;

    const showProblems = target.showProblems || ShowProblemTypes.Problems;
    const showProxy = target.options.hostProxy;

    const getProxiesPromise = showProxy ? this.zabbix.getProxies() : () => [];
    showAckButton = !this.disableReadOnlyUsersAck || userIsEditor;

    // Replace template variables
    const groupFilter = this.replaceTemplateVars(target.group?.filter, options.scopedVars);
    const hostFilter = this.replaceTemplateVars(target.host?.filter, options.scopedVars);
    const appFilter = this.replaceTemplateVars(target.application?.filter, options.scopedVars);
    const proxyFilter = this.replaceTemplateVars(target.proxy?.filter, options.scopedVars);

    const triggerFilter = this.replaceTemplateVars(target.trigger?.filter, options.scopedVars);
    const tagsFilter = this.replaceTemplateVars(target.tags?.filter, options.scopedVars);

    const replacedTarget = {
      ...target,
      trigger: { filter: triggerFilter },
      tags: { filter: tagsFilter },
    };

    // replaceTemplateVars() builds regex-like string, so we should trim it.
    const tagsFilterStr = tagsFilter.replace('/^', '').replace('$/', '');
    const tags = utils.parseTags(tagsFilterStr);
    tags.forEach(tag => {
      // Zabbix uses {"tag": "<tag>", "value": "<value>", "operator": "<operator>"} format, where 1 means Equal
      tag.operator = 1;
    });

    const problemsOptions: any = {
      recent: showProblems === ShowProblemTypes.Recent,
      minSeverity: target.options?.minSeverity,
      limit: target.options?.limit,
    };

    if (tags && tags.length) {
      problemsOptions.tags = tags;
    }

    if (target.options?.acknowledged === 0 || target.options?.acknowledged === 1) {
      problemsOptions.acknowledged = target.options?.acknowledged ? true : false;
    }

    if (target.options?.minSeverity) {
      const severities = [0, 1, 2, 3, 4, 5].filter(v => v >= target.options?.minSeverity);
      problemsOptions.severities = severities;
    }

    if (showProblems === ShowProblemTypes.History) {
      problemsOptions.timeFrom = timeFrom;
      problemsOptions.timeTo = timeTo;
    }

    const getProblemsPromise = showProblems === ShowProblemTypes.History ?
      this.zabbix.getProblemsHistory(groupFilter, hostFilter, appFilter, proxyFilter, problemsOptions) :
      this.zabbix.getProblems(groupFilter, hostFilter, appFilter, proxyFilter, problemsOptions);

    const problemsPromises = Promise.all([
      getProblemsPromise,
      getProxiesPromise
    ])
    .then(([problems, sourceProxies]) => {
      proxies = _.keyBy(sourceProxies, 'proxyid');
      return problems;
    })
    .then(problems => problemsHandler.setMaintenanceStatus(problems))
    .then(problems => problemsHandler.setAckButtonStatus(problems, showAckButton))
    .then(problems => problemsHandler.filterTriggersPre(problems, replacedTarget))
    .then(problems => problemsHandler.addTriggerDataSource(problems, target))
    .then(problems => problemsHandler.addTriggerHostProxy(problems, proxies));

    return problemsPromises.then(problems => {
      const problemsDataFrame = problemsHandler.toDataFrame(problems);
      return problemsDataFrame;
    });
  }

  /**
   * Test connection to Zabbix API and external history DB.
   */
  testDatasource() {
    return this.zabbix.testDataSource()
    .then(result => {
      const { zabbixVersion, dbConnectorStatus } = result;
      let message = `Zabbix API version: ${zabbixVersion}`;
      if (dbConnectorStatus) {
        message += `, DB connector type: ${dbConnectorStatus.dsType}`;
      }
      return {
        status: "success",
        title: "Success",
        message: message
      };
    })
    .catch(error => {
      if (error instanceof ZabbixAPIError) {
        return {
          status: "error",
          title: error.message,
          message: error.message
        };
      } else if (error.data && error.data.message) {
        return {
          status: "error",
          title: "Connection failed",
          message: "Connection failed: " + error.data.message
        };
      } else if (typeof(error) === 'string') {
        return {
          status: "error",
          title: "Connection failed",
          message: "Connection failed: " + error
        };
      } else {
        console.log(error);
        return {
          status: "error",
          title: "Connection failed",
          message: "Could not connect to given url"
        };
      }
    });
  }

  ////////////////
  // Templating //
  ////////////////

  /**
   * Find metrics from templated request.
   *
   * @param  {string} query Query from Templating
   * @return {string}       Metric name - group, host, app or item or list
   *                        of metrics in "{metric1,metcic2,...,metricN}" format.
   */
  metricFindQuery(query, options) {
    let resultPromise;
    let queryModel = _.cloneDeep(query);

    if (!query) {
      return Promise.resolve([]);
    }

    if (typeof query === 'string') {
      // Backward compatibility
      queryModel = utils.parseLegacyVariableQuery(query);
    }

    for (const prop of ['group', 'host', 'application', 'item']) {
      queryModel[prop] = this.replaceTemplateVars(queryModel[prop], {});
    }

    const { group, host, application, item } = queryModel;

    switch (queryModel.queryType) {
      case VariableQueryTypes.Group:
        resultPromise = this.zabbix.getGroups(queryModel.group);
        break;
      case VariableQueryTypes.Host:
        resultPromise = this.zabbix.getHosts(queryModel.group, queryModel.host);
        break;
      case VariableQueryTypes.Application:
        resultPromise = this.zabbix.getApps(queryModel.group, queryModel.host, queryModel.application);
        break;
      case VariableQueryTypes.Item:
        resultPromise = this.zabbix.getItems(queryModel.group, queryModel.host, queryModel.application, queryModel.item);
        break;
      case VariableQueryTypes.ItemValues:
        const range = options?.range;
        resultPromise = this.zabbix.getItemValues(group, host, application, item, { range });
        break;
      default:
        resultPromise = Promise.resolve([]);
        break;
    }

    return resultPromise.then(metrics => {
      return _.map(metrics, formatMetric);
    });
  }

  /////////////////
  // Annotations //
  /////////////////

  annotationQuery(options) {
    const timeRange = options.range || options.rangeRaw;
    const timeFrom = Math.ceil(dateMath.parse(timeRange.from) / 1000);
    const timeTo = Math.ceil(dateMath.parse(timeRange.to) / 1000);
    const annotation = options.annotation;

    // Show all triggers
    const problemsOptions: any = {
      value: annotation.showOkEvents ? ['0', '1'] : '1',
      valueFromEvent: true,
      timeFrom,
      timeTo,
    };

    if (annotation.minseverity) {
      const severities = [0, 1, 2, 3, 4, 5].filter(v => v >= Number(annotation.minseverity));
      problemsOptions.severities = severities;
    }

    const groupFilter = this.replaceTemplateVars(annotation.group, {});
    const hostFilter = this.replaceTemplateVars(annotation.host, {});
    const appFilter = this.replaceTemplateVars(annotation.application, {});
    const proxyFilter = undefined;

    return this.zabbix.getProblemsHistory(groupFilter, hostFilter, appFilter, proxyFilter, problemsOptions)
    .then(problems => {
      // Filter triggers by description
      const problemName = this.replaceTemplateVars(annotation.trigger, {});
      if (utils.isRegex(problemName)) {
        problems = _.filter(problems, p => {
          return utils.buildRegex(problemName).test(p.description);
        });
      } else if (problemName) {
        problems = _.filter(problems, p => {
          return p.description === problemName;
        });
      }

      // Hide acknowledged events if option enabled
      if (annotation.hideAcknowledged) {
        problems = _.filter(problems, p => {
          return !p.acknowledges?.length;
        });
      }

      return _.map(problems, p => {
        const formattedAcknowledges = utils.formatAcknowledges(p.acknowledges);

        let annotationTags: string[] = [];
        if (annotation.showHostname) {
          annotationTags = _.map(p.hosts, 'name');
        }

        return {
          title: p.value === '1' ? 'Problem' : 'OK',
          time: p.timestamp * 1000,
          annotation: annotation,
          text: p.name + formattedAcknowledges,
          tags: annotationTags,
        };
      });
    });
  }

  /**
   * Get triggers and its details for panel's targets
   * Returns alert state ('ok' if no fired triggers, or 'alerting' if at least 1 trigger is fired)
   * or empty object if no related triggers are finded.
   */
  alertQuery(options) {
    const enabled_targets = filterEnabledTargets(options.targets);
    const getPanelItems = _.map(enabled_targets, t => {
      let target = _.cloneDeep(t);
      target = migrations.migrate(target);
      this.replaceTargetVariables(target, options);
      return this.zabbix.getItemsFromTarget(target, {itemtype: 'num'});
    });

    return Promise.all(getPanelItems)
    .then(results => {
      const items = _.flatten(results);
      const itemids = _.map(items, 'itemid');

      if (itemids.length === 0) {
        return [];
      }
      return this.zabbix.getAlerts(itemids);
    })
    .then(triggers => {
      triggers = _.filter(triggers, trigger => {
        return trigger.priority >= this.alertingMinSeverity;
      });

      if (!triggers || triggers.length === 0) {
        return {};
      }

      let state = 'ok';

      const firedTriggers = _.filter(triggers, {value: '1'});
      if (firedTriggers.length) {
        state = 'alerting';
      }

      const thresholds = _.map(triggers, trigger => {
        return getTriggerThreshold(trigger.expression);
      });

      return {
        panelId: options.panelId,
        state: state,
        thresholds: thresholds
      };
    });
  }

  // Replace template variables
  replaceTargetVariables(target, options) {
    const parts = ['group', 'host', 'application', 'item'];
    _.forEach(parts, p => {
      if (target[p] && target[p].filter) {
        target[p].filter = this.replaceTemplateVars(target[p].filter, options.scopedVars);
      }
    });
    target.textFilter = this.replaceTemplateVars(target.textFilter, options.scopedVars);

    _.forEach(target.functions, func => {
      func.params = _.map(func.params, param => {
        if (typeof param === 'number') {
          return +this.templateSrv.replace(param.toString(), options.scopedVars);
        } else {
          return this.templateSrv.replace(param, options.scopedVars);
        }
      });
    });
  }

  isUseTrends(timeRange) {
    const [timeFrom, timeTo] = timeRange;
    const useTrendsFrom = Math.ceil(dateMath.parse('now-' + this.trendsFrom) / 1000);
    const useTrendsRange = Math.ceil(utils.parseInterval(this.trendsRange) / 1000);
    const useTrends = this.trends && (
      (timeFrom < useTrendsFrom) ||
      (timeTo - timeFrom > useTrendsRange)
    );
    return useTrends;
  }
}

function bindFunctionDefs(functionDefs, category) {
  const aggregationFunctions = _.map(metricFunctions.getCategories()[category], 'name');
  const aggFuncDefs = _.filter(functionDefs, func => {
    return _.includes(aggregationFunctions, func.def.name);
  });

  return _.map(aggFuncDefs, func => {
    const funcInstance = metricFunctions.createFuncInstance(func.def, func.params);
    return funcInstance.bindFunction(dataProcessor.metricFunctions);
  });
}

function getConsolidateBy(target) {
  let consolidateBy;
  const funcDef = _.find(target.functions, func => {
    return func.def.name === 'consolidateBy';
  });
  if (funcDef && funcDef.params && funcDef.params.length) {
    consolidateBy = funcDef.params[0];
  }
  return consolidateBy;
}

function downsampleSeries(timeseries_data, options) {
  const defaultAgg = dataProcessor.aggregationFunctions['avg'];
  const consolidateByFunc = dataProcessor.aggregationFunctions[options.consolidateBy] || defaultAgg;
  return _.map(timeseries_data, timeseries => {
    if (timeseries.datapoints.length > options.maxDataPoints) {
      timeseries.datapoints = dataProcessor
        .groupBy(options.interval, consolidateByFunc, timeseries.datapoints);
    }
    return timeseries;
  });
}

function formatMetric(metricObj) {
  return {
    text: metricObj.name,
    expandable: false
  };
}

/**
 * Custom formatter for template variables.
 * Default Grafana "regex" formatter returns
 * value1|value2
 * This formatter returns
 * (value1|value2)
 * This format needed for using in complex regex with
 * template variables, for example
 * /CPU $cpu_item.*time/ where $cpu_item is system,user,iowait
 */
export function zabbixTemplateFormat(value) {
  if (typeof value === 'string') {
    return utils.escapeRegex(value);
  }

  const escapedValues = _.map(value, utils.escapeRegex);
  return '(' + escapedValues.join('|') + ')';
}

function zabbixItemIdsTemplateFormat(value) {
  if (typeof value === 'string') {
    return value;
  }
  return value.join(',');
}

/**
 * If template variables are used in request, replace it using regex format
 * and wrap with '/' for proper multi-value work. Example:
 * $variable selected as a, b, c
 * We use filter $variable
 * $variable    -> a|b|c    -> /a|b|c/
 * /$variable/  -> /a|b|c/  -> /a|b|c/
 */
function replaceTemplateVars(templateSrv, target, scopedVars) {
  let replacedTarget = templateSrv.replace(target, scopedVars, zabbixTemplateFormat);
  if (target !== replacedTarget && !utils.isRegex(replacedTarget)) {
    replacedTarget = '/^' + replacedTarget + '$/';
  }
  return replacedTarget;
}

function filterEnabledTargets(targets) {
  return _.filter(targets, target => {
    return !(target.hide || !target.group || !target.host || !target.item);
  });
}

function getTriggerThreshold(expression) {
  const thresholdPattern = /.*[<>=]{1,2}([\d\.]+)/;
  const finded_thresholds = expression.match(thresholdPattern);
  if (finded_thresholds && finded_thresholds.length >= 2) {
    let threshold = finded_thresholds[1];
    threshold = Number(threshold);
    return threshold;
  } else {
    return null;
  }
}
