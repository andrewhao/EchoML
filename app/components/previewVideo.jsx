// @flow
import { connect } from 'react-redux';
import React from 'react';
import { locToUrl, calcDisplaySize } from '../common/util';
import { loadAnnotation, loadLabels, playFile } from '../annotations';
import { loadEmitter } from '../emitter';
import * as actions from '../actions';
import Alert from './alert';

class PreviewVideo extends React.Component {
  playlist = null;
  static propTypes = {
    dispatch: React.PropTypes.func,
    loc: React.PropTypes.object,
    preview: React.PropTypes.object,
    containers: React.PropTypes.array,
  };

  saveLabels() {
    const fullpath = locToUrl(this.props.loc);
    const index = fullpath.lastIndexOf('/');
    const storageAccount = this.props.containers[fullpath.substring(index + 1)].storageAccount;
    const containerName = this.props.containers[fullpath.substring(index + 1)].name;
    this.props.dispatch(
      actions.saveLabels(
        storageAccount,
        containerName,
        this.props.preview.filename,
        this.playlist.annotationList.annotations,
      ),
    );
  }

  componentDidMount() {
    const labels = loadLabels(this.props.preview.labels);
    this.playlist = loadAnnotation(labels);

    loadEmitter(this.playlist);
    const fullpath = locToUrl(this.props.loc);
    const index = fullpath.lastIndexOf('/');
    const storageAccount = this.props.containers[fullpath.substring(index + 1)].storageAccount;
    const containerName = this.props.containers[fullpath.substring(index + 1)].name;

    const filePromise = this.props.dispatch(
      actions.downloadFile(storageAccount, containerName, this.props.preview.filename),
    );
    const spectrogramPromise = this.props.dispatch(
      actions.downloadFile(
        storageAccount,
        containerName,
        this.props.preview.filename.replace('.flac', '.png'),
      ),
    );

    // Download files and begin playing
    Promise.all([filePromise, spectrogramPromise])
      .then((values) => {
        const localFileUrl = values[0];
        const localSpectroUrl = values[1];
        playFile(this.playlist, localFileUrl, localSpectroUrl);
      })
      .catch((reason) => {
        console.error(reason);
      });
  }

  componentWillUnmount() {
    // fixes issue with 'AudioContext': number of hardware contexts reached maximum
    this.playlist.ac.close();
  }

  render() {
    const preImgStyle = {
      position: 'absolute',
      width: '100%',
      textAlign: 'center',
      color: '#ccc',
    };
    const preStyle = {
      position: 'relative',
      display: 'block',
      overflow: 'hidden',
    };
    const playlistStyle = {
      background: '#fff',
    };
    const captionStyle = {
      position: 'absolute',
      bottom: '2em',
      width: '100%',
      textAlign: 'center',
    };
    const imageStyle = {
      position: 'relative',
      display: 'block',
      left: '400px',
      top: '40px',
    };

    const outWidth = window.document.documentElement.clientWidth;
    const outHeight = window.document.documentElement.clientHeight;
    const displaySize = calcDisplaySize(outWidth, outHeight, outWidth, outHeight);
    preStyle.width = `${displaySize.width}px`;
    preStyle.height = `${displaySize.height}px`;
    preStyle.left = `${(outWidth - displaySize.width) / 2}px`;
    preStyle.top = `${(outHeight - displaySize.height) / 2}px`;

    playlistStyle.height = `${displaySize.height / 2}px`;

    const preImgStyleY = (outHeight - displaySize.height) / 2;
    preImgStyle.top = `${preImgStyleY}px`;

    return (
      <div>
        <div style={preStyle}>
          <Alert />
          <div id="top-bar" className="playlist-top-bar">
            <div className="playlist-toolbar">
              <div className="btn-group">
                <span className="btn-pause btn btn-warning">
                  <i className="fa fa-pause" />
                </span>
                <span className="btn-play btn btn-success">
                  <i className="fa fa-play" />
                </span>
                <span className="btn-stop btn btn-danger">
                  <i className="fa fa-stop" />
                </span>
                <span className="btn-rewind btn btn-success">
                  <i className="fa fa-fast-backward" />
                </span>
                <span className="btn-fast-forward btn btn-success">
                  <i className="fa fa-fast-forward" />
                </span>
              </div>
              <div className="btn-group btn-playlist-state-group">
                <span className="btn-cursor btn btn-default active" title="select cursor">
                  <i className="fa fa-headphones" />
                </span>
                <span className="btn-select btn btn-default" title="select audio region">
                  <i className="fa fa-italic" />
                </span>
              </div>
              <div className="btn-group" onClick={() => this.saveLabels()}>
                <span
                  title="Save the labels as json"
                  className="btn-annotations-download btn btn-success"
                >
                  Save Labels
                </span>
              </div>
            </div>
          </div>
          <div id="playlist" style={playlistStyle} />
        </div>

        <div style={captionStyle}>
          {this.props.preview.filename}
        </div>
      </div>
    );
  }
}

const mapStateToProps = state => ({
  loc: state.loc,
  preview: state.preview,
  containers: state.containers,
});

export default connect(mapStateToProps)(PreviewVideo);
