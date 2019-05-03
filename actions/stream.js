import querystring from 'querystring';

import { _request } from '../index';

import config from '../config';
import { getUrlInfo } from '../util/helpers';
import { addEntities, removeEntities } from './entities';
import schemaTree from '../util/schemaTree.json';

export const UPDATE_STREAM = 'UPDATE_STREAM';
export const REMOVE_STREAM = 'REMOVE_STREAM';

const lostTimer = 1000 * 60;
const retryTimer = 1000 * 5;

let timeouts = {};

//add also connection lost and timer of 5 minutes of waiting in general
export const status = {
  CONNECTING: 1,
  OPEN: 2,
  CLOSED: 3,
  RECONNECTING: 4,
  ERROR: 5,
  LOST: 6
};

export const steps = {
  CONNECTING: {
    GET_STREAM: 1,
    CREATE_STREAM: 2,
    UPDATE_STREAM: 3,
    OPENING_SOCKET: 4,
    WAITING: 5
  }
}

export function updateStream(name, status, step, ws, json, increment){
  return {
    type: UPDATE_STREAM,
    name,
    status,
    step,
    ws,
    json,
    increment
  }
}

export function openStream(streamJSON = {}, session){
  return (dispatch, getState) => {
    if(!streamJSON.name){
      console.log("open stream requires a name to work");
      return;
    }
    if(!session){
      session = getState().session && getState().session.meta.id;
    }
    _startStream(streamJSON, session, getState, dispatch);
  };
}

export function closeStream(name){
  return (dispatch, getState) => {
    let state = getState();
    if(state.stream && state.stream[name]){
      if(timeouts[stream.name]){
        _clearStreamTimeouts(stream);
      }
      if(state.stream[name].ws){
        state.stream[name].ws.close();
        clearTimeout(state.stream[name].timeout);
        dispatch(removeStream(name));
      }
    }
  };
}

function _mergeStreams(oldJSON, newJSON){
  let update = false;
  if(newJSON.subscription){
    newJSON.subscription.forEach((sub) => {
      if(oldJSON.subscription.indexOf(sub) === -1){
        update = true;
        oldJSON.subscription.push(sub);
      }
    });
  }
  if(newJSON.ignore){
    newJSON.ignore.forEach((sub) => {
      if(oldJSON.ignore.indexOf(sub) === -1){
        update = true;
        oldJSON.ignore.push(sub);
      }
    });
  }
  if(oldJSON.full !== newJSON.full){
    update = true;
    oldJSON = newJSON.full;
  }
  return update ? oldJSON : undefined;
}

async function _createStream(streamJSON, session, dispatch) {
  dispatch(updateStream(streamJSON.name, status.CONNECTING, steps.CONNECTING.UPDATE_STREAM));
  let response = await _request({
    url: config.baseUrl + '/stream',
    method: 'POST',
    body: JSON.stringify(streamJSON),
    headers : { 'x-session': session }
  });
  if(!response.ok){
    throw response;
  }
  let json = response.json;
  return json;
}

function _addChildren(message, state){
  let type = message.meta_object.type;
  let data = message[type];
  if(schemaTree[type] && schemaTree[type].dependencies){
    let cachedData = state.entities[schemaTree[type].name] && state.entities[schemaTree[type].name][data.meta.id];
    schemaTree[type].dependencies.forEach(({key, type}) => {
      data[key] = cachedData ? cachedData[key] : ( type === 'many' ? [] : undefined );
    });
  }
}

function _clearStreamTimeouts(stream){
  clearTimeout(timeouts[stream.name].retryTimeout);
  clearTimeout(timeouts[stream.name].lostTimeout);
  delete timeouts[stream.name];
}

function _startStream(stream, session, getState, dispatch, reconnecting){
  let url;
  if(stream.meta.id){
    url = config.baseUrl + '/stream/' + stream.meta.id + '?x-session=' + session;
  } else {
    url = config.baseUrl + '/stream/?x-session=' + session + '&' + querystring.stringify(stream);
  }
  let ws = new WebSocket(url);

  dispatch(updateStream(stream.name, reconnecting ? status.RECONNECTING : status.CONNECTING, steps.CONNECTING.OPENING_SOCKET, ws));

  ws.onopen = () => {
    if(timeouts[stream.name]){
      _clearStreamTimeouts(stream);
    }
    dispatch(updateStream(stream.name, status.OPEN, null, ws));
    console.log('Stream open: ' + url);
  };

  ws.onmessage = (e) => {
    // a message was received
    try{
      let data = JSON.parse(e.data);
      data.forEach(message => {
        let state = getState();
        switch(message.event){
          case 'create':
            // since stream does not have child list, I'm going to add it from cached store state
            _addChildren(message, state);
            if(message.meta_object.type === 'state'){
              if(schemaTree.state && schemaTree.state.name && state.entities[schemaTree.state.name].hasOwnProperty(message.meta_object.id)){
                dispatch(addEntities(message.meta_object.type, message[message.meta_object.type], { reset: false }));
              } else {
                let { parent } = getUrlInfo(message.path, 1);
                dispatch(addEntities(message.meta_object.type, [message[message.meta_object.type]], { reset: false, parent }));
              }
            } else {
              let { parent } = getUrlInfo(message.path, 1);
              dispatch(addEntities(message.meta_object.type, message[message.meta_object.type], { reset: false, parent }));
            }
            break;
          case 'update':
            // since stream does not have child list, I'm going to add it from cached store state
            _addChildren(message, state);
            dispatch(addEntities(message.meta_object.type, message[message.meta_object.type], { reset: false }));
            break;
          case 'delete':
            let { parent } = getUrlInfo(message.path, 1);
            dispatch(removeEntities(message.meta_object.type, [message.meta_object.id]), { parent });
            break;
        }
      })
    } catch(e){
      console.log('stream catch', e);
    }
  };

  ws.onerror = (e) => {
    console.log('Stream error: ' + url);
  };

  ws.onclose = (e) => {
    console.log('Stream close: ' + url);
    if(e.code !== 4001){
      if(!timeouts[stream.name]){
        timeouts[stream.name] = {};
      }
      let retryTimeout = setTimeout(() => {
        _startStream(stream, session, getState, dispatch, true);
      }, retryTimer);
      timeouts[stream.name].retryTimeout = retryTimeout;
      if(!reconnecting){
        let lostTimeout = setTimeout(() => {
          _clearStreamTimeouts(stream);
          dispatch(updateStream(stream.name, status.LOST, null, null, stream));
        }, lostTimer);
        timeouts[stream.name].lostTimeout = lostTimeout;
      }
      dispatch(updateStream(stream.name, status.RECONNECTING, steps.CONNECTING.WAITING, ws, null, true));
    } else {
      dispatch(updateStream(stream.name, status.CLOSED, e.code, ws, stream));
    }
  };
}

export function initializeStream(streamJSON = {}, session){
  return async (dispatch, getState) => {
    if(!_request){
      console.log('request function is not set');
      return;
    }
    if(!session){
      session = getState().session && getState().session.meta.id;
    }
    if(!session){
      // dispatch no session maybe ?
      console.log('no session specified');
      return;
    }
    try{
      dispatch(updateStream(streamJSON.name, status.CONNECTING, steps.CONNECTING.GET_STREAM));
      let headers = { 'x-session': session };
      let url = config.baseUrl + '/stream?expand=0';
      if(streamJSON.name){
        url += '&this_name='+streamJSON.name
      }
      let response = await _request({ url, headers });
      if(!response.ok){
        throw response;
      }
      let json = response.json;
      if (json.length > 0) {
        if (!streamJSON.hasOwnProperty('full')) {
            streamJSON.full = true;
        }
        let stream = json[0];

        // merging with json
        let newJSON = _mergeStreams(stream, streamJSON);

        if(newJSON){
          dispatch(updateStream(streamJSON.name, status.CONNECTING, steps.CONNECTING.UPDATE_STREAM));
          let updateResponse = await _request({
            url: config.baseUrl + '/stream/' + stream.meta.id,
            method: 'PATCH',
            body: JSON.stringify(newJSON),
            headers
          });
          if(!updateResponse.ok){
            throw updateResponse;
          }
        }
        return _startStream(newJSON || stream, session, getState, dispatch);
      } else {
        let stream = await _createStream(streamJSON, session, dispatch);
        return _startStream(stream, session, getState, dispatch);
      }
    } catch(e) {
      console.log("initializeStream error", e);
      dispatch(updateStream(streamJSON.name, status.ERROR));
    }
  };
}
