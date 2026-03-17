import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button, Input, List, Modal, Form, Select, message, Progress, Typography } from 'antd';

const { Text } = Typography;

const { Option } = Select

function SshManager() {
  const [ connections, setConnections ] = useState([])
  const [ visible, setVisible ] = useState(false)
  const [ currentConnection, setCurrentConnection ] = useState(null)
  const [ command, setCommand ] = useState('')
  const [ output, setOutput ] = useState('')
  const [ uploadVisible, setUploadVisible ] = useState(false)
  const [ downloadVisible, setDownloadVisible ] = useState(false)
  const [uploadForm] = Form.useForm()
  const [downloadForm] = Form.useForm()
  const [ isLoading, setIsLoading ] = useState(false)
  const [ progress, setProgress ] = useState(0)
  const [ logs, setLogs ] = useState([])

  const addLog = (message) => {
    const timestamp = new Date().toLocaleString()
    setLogs(prev => [...prev, { timestamp, message }])
    console.log(`${timestamp}: ${message}`)
  }

  useEffect(() => {
    loadConnections()
  }, [])

  const loadConnections = async () => {
    try {
      addLog('Loading SSH connections...')
      const result = await invoke('list_ssh_connections')
      setConnections(result)
      addLog(`Loaded ${result.length} SSH connections`)
    } catch (error) {
      message.error('Failed to load connections: ' + error)
      addLog('Failed to load connections: ' + error)
    }
  }

  const handleAddConnection = async (values) => {
    try {
      addLog(`Adding SSH connection: ${values.host}:${values.port}`)
      await invoke('add_ssh_connection', {
        host: values.host,
        port: values.port,
        username: values.username,
        password: values.password
      })
      message.success('Connection added successfully')
      addLog('Connection added successfully')
      setVisible(false)
      loadConnections()
    } catch (error) {
      message.error('Failed to add connection: ' + error)
      addLog('Failed to add connection: ' + error)
    }
  }

  const handleConnect = async (id) => {
    try {
      addLog(`Connecting to SSH connection: ${id}`)
      await invoke('connect_ssh', { id })
      message.success('Connected successfully')
      addLog('Connected successfully')
      loadConnections()
    } catch (error) {
      message.error('Failed to connect: ' + error)
      addLog('Failed to connect: ' + error)
    }
  }

  const handleDisconnect = async (id) => {
    try {
      addLog(`Disconnecting from SSH connection: ${id}`)
      await invoke('disconnect_ssh', { id })
      message.success('Disconnected successfully')
      addLog('Disconnected successfully')
      loadConnections()
    } catch (error) {
      message.error('Failed to disconnect: ' + error)
      addLog('Failed to disconnect: ' + error)
    }
  }

  const handleExecuteCommand = async () => {
    if (!currentConnection) {
      message.error('Please select a connection')
      return
    }

    try {
      addLog(`Executing command: ${command} on ${currentConnection.host}:${currentConnection.port}`)
      setIsLoading(true)
      const result = await invoke('execute_ssh_command', {
        id: currentConnection.id,
        command
      })
      setOutput(result)
      message.success('Command executed successfully')
      addLog('Command executed successfully')
      addLog(`Command output: ${result}`)
    } catch (error) {
      message.error('Failed to execute command: ' + error)
      setOutput(error)
      addLog('Failed to execute command: ' + error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleUpload = async (values) => {
    if (!currentConnection) {
      message.error('Please select a connection')
      return
    }

    try {
      addLog(`Uploading file: ${values.localPath} to ${currentConnection.host}:${values.remotePath}`)
      setIsLoading(true)
      setProgress(0)
      // 模拟上传进度
      const interval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 90) {
            clearInterval(interval)
            return prev
          }
          return prev + 10
        })
      }, 200)

      const result = await invoke('scp_upload', {
        id: currentConnection.id,
        local_path: values.localPath,
        remote_path: values.remotePath
      })

      clearInterval(interval)
      setProgress(100)
      message.success(result)
      addLog('File uploaded successfully')
      setUploadVisible(false)
      uploadForm.resetFields()
    } catch (error) {
      message.error('Failed to upload file: ' + error)
      addLog('Failed to upload file: ' + error)
    } finally {
      setIsLoading(false)
      setProgress(0)
    }
  }

  const handleDownload = async (values) => {
    if (!currentConnection) {
      message.error('Please select a connection')
      return
    }

    try {
      addLog(`Downloading file: ${currentConnection.host}:${values.remotePath} to ${values.localPath}`)
      setIsLoading(true)
      setProgress(0)
      // 模拟下载进度
      const interval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 90) {
            clearInterval(interval)
            return prev
          }
          return prev + 10
        })
      }, 200)

      const result = await invoke('scp_download', {
        id: currentConnection.id,
        remote_path: values.remotePath,
        local_path: values.localPath
      })

      clearInterval(interval)
      setProgress(100)
      message.success(result)
      addLog('File downloaded successfully')
      setDownloadVisible(false)
      downloadForm.resetFields()
    } catch (error) {
      message.error('Failed to download file: ' + error)
      addLog('Failed to download file: ' + error)
    } finally {
      setIsLoading(false)
      setProgress(0)
    }
  }

  return (
    <div style={{ padding: '20px' }}>
      <Button type="primary" onClick={() => setVisible(true)} style={{ marginBottom: '20px' }}>
        Add SSH Connection
      </Button>

      <List
        itemLayout="horizontal"
        dataSource={connections}
        renderItem={item => (
          <List.Item
            actions={[
              item.connected ? (
                <Button danger onClick={() => handleDisconnect(item.id)}>
                  Disconnect
                </Button>
              ) : (
                <Button type="primary" onClick={() => handleConnect(item.id)}>
                  Connect
                </Button>
              ),
              <Button
                onClick={() => setCurrentConnection(item)}
                disabled={!item.connected}
              >
                Select
              </Button>
            ]}
          >
            <List.Item.Meta
              title={`${ item.host }:${ item.port }`}
              description={`${ item.username } - ${ item.connected ? 'Connected' : 'Disconnected' }`}
            />
          </List.Item>
        )}
      />

      {currentConnection && (
        <div style={{ marginTop: '20px', padding: '20px', border: '1px solid #e8e8e8', borderRadius: '4px' }}>
          <h3>Selected Connection: {currentConnection.host}:{currentConnection.port}</h3>

          <div style={{ marginTop: '20px' }}>
            <h4>Execute Command</h4>
            <Input.TextArea
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder="Enter command to execute"
              style={{ marginBottom: '10px' }}
            />
            <Button type="primary" onClick={handleExecuteCommand} loading={isLoading}>
              Execute
            </Button>
            {output && (
              <div style={{ marginTop: '10px', padding: '10px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
                <pre>{output}</pre>
              </div>
            )}
          </div>

          <div style={{ marginTop: '20px' }}>
            <Button onClick={() => setUploadVisible(true)} style={{ marginRight: '10px' }}>
              Upload File
            </Button>
            <Button onClick={() => setDownloadVisible(true)}>
              Download File
            </Button>
          </div>
        </div>
      )}

      {/* Add Connection Modal */}
      <Modal
        title="Add SSH Connection"
        open={visible}
        onCancel={() => setVisible(false)}
        footer={null}
      >
        <Form onFinish={handleAddConnection} layout="vertical">
          <Form.Item name="host" label="Host" rules={[{ required: true }]}>
            <Input placeholder="Enter host" />
          </Form.Item>
          <Form.Item name="port" label="Port" rules={[{ required: true }]} initialValue={22}>
            <Input type="number" placeholder="Enter port" />
          </Form.Item>
          <Form.Item name="username" label="Username" rules={[{ required: true }]}>
            <Input placeholder="Enter username" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password placeholder="Enter password" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" style={{ marginRight: '10px' }}>
              Add
            </Button>
            <Button onClick={() => setVisible(false)}>
              Cancel
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* Upload File Modal */}
      <Modal
        title="Upload File"
        open={uploadVisible}
        onCancel={() => setUploadVisible(false)}
        footer={null}
      >
        <Form form={uploadForm} onFinish={handleUpload} layout="vertical">
          <Form.Item name="localPath" label="Local Path" rules={[{ required: true }]}>
            <Input placeholder="Enter local file path" />
          </Form.Item>
          <Form.Item name="remotePath" label="Remote Path" rules={[{ required: true }]}>
            <Input placeholder="Enter remote file path" />
          </Form.Item>
          {progress > 0 && (
            <Progress percent={progress} status="active" style={{ marginBottom: '10px' }} />
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={isLoading} style={{ marginRight: '10px' }}>
              Upload
            </Button>
            <Button onClick={() => setUploadVisible(false)} disabled={isLoading}>
              Cancel
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* Download File Modal */}
      <Modal
        title="Download File"
        open={downloadVisible}
        onCancel={() => setDownloadVisible(false)}
        footer={null}
      >
        <Form form={downloadForm} onFinish={handleDownload} layout="vertical">
          <Form.Item name="remotePath" label="Remote Path" rules={[{ required: true }]}>
            <Input placeholder="Enter remote file path" />
          </Form.Item>
          <Form.Item name="localPath" label="Local Path" rules={[{ required: true }]}>
            <Input placeholder="Enter local file path" />
          </Form.Item>
          {progress > 0 && (
            <Progress percent={progress} status="active" style={{ marginBottom: '10px' }} />
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={isLoading} style={{ marginRight: '10px' }}>
              Download
            </Button>
            <Button onClick={() => setDownloadVisible(false)} disabled={isLoading}>
              Cancel
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* Logs Panel */}
      <div style={{ marginTop: '30px', padding: '20px', border: '1px solid #333', borderRadius: '4px', backgroundColor: '#1e1e1e' }}>
        <h3 style={{ color: '#ffffff', marginBottom: '15px' }}>Logs</h3>
        <div style={{ maxHeight: '300px', overflowY: 'auto', backgroundColor: '#141414', padding: '10px', borderRadius: '4px' }}>
          {logs.length === 0 ? (
            <Text type="secondary">No logs yet</Text>
          ) : (
            logs.map((log, index) => (
              <div key={index} style={{ marginBottom: '5px', fontSize: '12px' }}>
                <Text type="secondary">[{log.timestamp}]</Text> {log.message}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default SshManager
